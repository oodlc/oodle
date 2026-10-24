import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { scriptedModel } from '@oodle/compile';
import { readGaps } from '@oodle/gaps';
import { loadSpec } from '@oodle/spec';
import { describe, expect, it } from 'vitest';
import { DOGWALK_A, DOGWALK_B, variant } from '../../sim/test/fixtures/variants.ts';
import { runInterview } from '../src/commands/interview.ts';
import { mcpServer } from '../src/commands/mcp.ts';
import { context } from '../src/context.ts';
import { oodle, project, scriptedAnswers } from './helpers.ts';

describe('oodle interview', () => {
  it('writes the declared tier from answers, with entities a model suggested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oodle-interview-'));
    const answers = [
      'Owners can book a trusted walker in under a minute.',
      'owner, walker',
      'book walks, cancel their own walks',
      'accept or decline walks',
      '', // keep the suggested entities
      '', // keep the suggested fields
      'requested -> accepted -> done | declined | cancelled',
      'A walker has at most one walk at any moment',
      '',
      'Ada picks Sam for Tuesday 9:00, 30 minutes: she sees "Requested, $20"',
      '',
      'Sam accepts the walk: he sees "Accepted"',
      '',
      "An owner is never charged for a walk that didn't happen; No one sees another owner's address",
      'Runs on Cloudflare Workers with D1',
    ];
    const said: string[] = [];
    const model = scriptedModel({
      'interview entities': { entities: [{ name: 'walk', fields: ['owner', 'walker', 'starts_at', 'minutes'], states: 'requested -> accepted' }] },
    });
    await runInterview(root, { ask: async () => answers.shift() ?? '', say: (t) => said.push(t) }, model);
    const { spec } = loadSpec(root);
    expect(spec.personas).toEqual({ owner: { can: ['book walks', 'cancel their own walks'] }, walker: { can: ['accept or decline walks'] } });
    expect(spec.domain.walk).toEqual({
      fields: { owner: null, walker: null, starts_at: null, minutes: null },
      states: 'requested -> accepted -> done | declined | cancelled',
      rules: ['A walker has at most one walk at any moment'],
    });
    expect(spec.journeys.map((j) => [j.id, j.steps.length])).toEqual([
      ['first-owner', 1],
      ['first-walker', 1],
    ]);
    expect(spec.constraints.map((c) => c.text)).toEqual([
      "An owner is never charged for a walk that didn't happen",
      "No one sees another owner's address",
      'Runs on Cloudflare Workers with D1',
    ]);
    expect(spec.decisions).toEqual([]);
    expect(said.at(-1)).toMatch(/Next: `oodle compile`/);
  });

  it('needs a person at a terminal', async () => {
    expect((await oodle(mkdtempSync(join(tmpdir(), 'oodle-interview-')), 'interview')).code).toBe(3);
  });
});

describe('oodle mcp', () => {
  it('lets an agent read the spec and answer agent-routed gaps, and nothing routed to people', async () => {
    const root = project();
    process.env.OODLE_SCRIPTED_MODEL = scriptedAnswers(mkdtempSync(join(tmpdir(), 'oodle-ans-')), {});
    try {
      await oodle(root, 'gaps', '--a', DOGWALK_A, '--b', variant(DOGWALK_B));
    } finally {
      delete process.env.OODLE_SCRIPTED_MODEL;
    }
    const server = mcpServer({ ...context({ root }), print: () => {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.sort()).toEqual(['answer_gap', 'get_gap', 'list_gaps', 'list_intents', 'read_compiled', 'read_spec', 'verify']);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { error: !!r.isError, text: r.content[0]?.text ?? '' };
    };
    expect(JSON.parse((await call('read_spec')).text).spec.intent).toMatch(/^Owners can book/);
    const gaps = readGaps(root);
    const human = gaps.find((g) => g.route === 'human');
    const agent = gaps.find((g) => g.kind === 'wording');
    expect(await call('answer_gap', { id: human?.id, option: 'a', reason: 'x' })).toMatchObject({ error: true, text: `${human?.id} is routed to people.` });
    const ok = await call('answer_gap', { id: agent?.id, option: 'a', reason: 'the friendlier wording' });
    expect(ok.error).toBe(false);
    expect(readGaps(root).find((g) => g.id === agent?.id)).toMatchObject({ status: 'applied', answered_by: 'agent:mcp@local' });
    await client.close();
  });
});
