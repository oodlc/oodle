/**
 * `oodle mcp`: Oodle as a Model Context Protocol server over stdio, for a local agent. It can read
 * the spec, the compiled scenarios and the gaps, run verify, and answer gaps routed to agents, with
 * the same rules as the CLI: no tool answers a gap routed to people, writes the declared tier or
 * approves an intent. Those are people's.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readCompiled } from '@oodle/compile';
import { readGaps } from '@oodle/gaps';
import { loadSpec, readIntents, specHash } from '@oodle/spec';
import { AnswerRefused, applyAnswer, recordApplied, uncommittedSpec } from '@oodle/sync';
import { summarize, verify } from '@oodle/verify';
import { z } from 'zod';
import { resolveBuild } from '../builds.ts';
import type { Ctx } from '../context.ts';
import { compiled } from './basics.ts';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const refuse = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export function mcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'oodle', version: '0.1.0' });

  server.registerTool('read_spec', { description: 'The spec: intent, personas, domain, journeys, constraints and decisions, with its hash.' }, async () => {
    const { spec, layout } = loadSpec(ctx.root);
    return text({ layout, spec_hash: specHash(spec), spec });
  });

  server.registerTool(
    'read_compiled',
    { description: 'What the simulation runs: the action and screen vocabulary, compiled journeys, and the checks.' },
    async () => {
      const c = readCompiled(ctx.root);
      return text({ vocabulary: c.vocabulary, journeys: c.journeys, checks: c.checks });
    },
  );

  server.registerTool(
    'list_gaps',
    {
      description: 'Gaps: questions two builds left open. Filter by status (open, applied, …) and route (agent, human).',
      inputSchema: { status: z.string().optional(), route: z.enum(['agent', 'human']).optional() },
    },
    async ({ status, route }) =>
      text(
        readGaps(ctx.root)
          .filter((g) => (!status || g.status === status) && (!route || g.route === route))
          .map((g) => ({ id: g.id, status: g.status, kind: g.kind, tier: g.tier, route: g.route, question: g.question, options: g.options })),
      ),
  );

  server.registerTool('get_gap', { description: 'One gap, with its evidence and options.', inputSchema: { id: z.string() } }, async ({ id }) => {
    const gap = readGaps(ctx.root).find((g) => g.id === id);
    return gap ? text(gap) : refuse(`No gap ${id}.`);
  });

  server.registerTool(
    'answer_gap',
    {
      description:
        'Settle a gap routed to agents, with one option, and say why in one sentence. Gaps routed to people, and anything that writes the declared tier, are refused: those need a person.',
      inputSchema: { id: z.string(), option: z.string(), reason: z.string().min(1) },
    },
    async ({ id, option, reason }) => {
      const gap = readGaps(ctx.root).find((g) => g.id === id);
      if (!gap) return refuse(`No gap ${id}.`);
      if (gap.route !== 'agent')
        return refuse(`${id} is routed to people${ctx.config.remote ? `; it is answered in the inbox (${ctx.config.remote.url})` : ''}.`);
      const blocking = uncommittedSpec(ctx.root);
      if (blocking.length) return refuse(`The spec has uncommitted changes: ${blocking.join(', ')}`);
      try {
        const out = applyAnswer(ctx.root, id, { option, reason }, `agent:${process.env.OODLE_AGENT_NAME ?? 'mcp'}@local`);
        if (out.sha) recordApplied(ctx.root, [{ gap: id, sha: out.sha }]);
        return text({ applied: id, changed: out.changed, sha: out.sha ?? null });
      } catch (e) {
        if (e instanceof AnswerRefused) return refuse(e.message);
        throw e;
      }
    },
  );

  server.registerTool('list_intents', { description: 'Intents: changes to the app, their status and approvals.' }, async () =>
    text(readIntents(ctx.root).map(({ file, intent }) => ({ file, ...intent }))),
  );

  server.registerTool(
    'verify',
    {
      description: 'Check a build (an id, or an app folder; default the latest) against the spec. Returns the summary and every finding.',
      inputSchema: { build: z.string().optional(), explore: z.boolean().optional() },
    },
    async ({ build, explore }) => {
      const b = resolveBuild(ctx, build);
      const report = await verify(b.dir, await compiled(ctx), { explore });
      const { results: _results, ...rest } = report;
      return text({ summary: summarize(report), ...rest });
    },
  );

  return server;
}

export async function mcpCommand(ctx: Ctx): Promise<number> {
  const server = mcpServer({ ...ctx, print: () => {} });
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.on('close', resolve));
  return 0;
}
