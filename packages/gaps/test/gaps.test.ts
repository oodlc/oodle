import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompiled, scriptedModel } from '@oodle/compile';
import { cluster, diffRuns } from '@oodle/diff';
import { loadBuild, runScenarios, type Scenario } from '@oodle/sim';
import { loadConfig, loadSpec, specHash } from '@oodle/spec';
import { beforeAll, describe, expect, it } from 'vitest';
import { DOGWALK_A, DOGWALK_B, variant } from '../../sim/test/fixtures/variants.ts';
import { addIgnore, contentHash, describeScenario, type Gap, gapPath, raiseGaps, readGaps, writeGap } from '../src/index.ts';

const EXAMPLE = join(import.meta.dirname, '../../../examples/dogwalk');
const compiled = readCompiled(EXAMPLE);
const vocab = compiled.vocabulary!;
const scenarios = [...compiled.journeys.map((j) => j.scenario), ...(compiled.explore?.scenarios ?? [])] as Scenario[];
const spec = loadSpec(EXAMPLE).spec;

let signatures: ReturnType<typeof cluster>;
beforeAll(async () => {
  const [a, b] = await Promise.all([loadBuild(DOGWALK_A), loadBuild(variant(DOGWALK_B))]);
  const [ra, rb] = await Promise.all([runScenarios(a, scenarios), runScenarios(b, scenarios)]);
  signatures = cluster(diffRuns({ scenarios, entities: Object.keys(spec.domain), entityOf: (x) => vocab.actions.find((v) => v.id === x)?.entity }, ra, rb));
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'oodle-gaps-'));
  cpSync(join(EXAMPLE, 'oodle'), join(root, 'oodle'), { recursive: true });
  return root;
}
const opts = (root: string, extra = {}) => ({
  spec,
  vocab,
  scenarios,
  specHash: specHash(spec),
  foundIn: ['build:a', 'build:b'],
  config: loadConfig(root),
  ...extra,
});

describe('raising gaps', () => {
  it('writes one question per gap, with tier and route', async () => {
    const root = project();
    const { open } = await raiseGaps(root, signatures, opts(root));
    const byKind = Object.fromEntries(open.map((g) => [g.kind, g]));
    expect(Object.keys(byKind).sort()).toEqual(['permission', 'sort_order', 'wording']);
    expect(byKind.permission).toMatchObject({ tier: 'declared', route: 'human', tier_reason: 'who may do what is declared in personas' });
    expect(byKind.sort_order).toMatchObject({ tier: 'decided', route: 'agent' });
    expect(byKind.wording).toMatchObject({
      tier: 'decided',
      route: 'agent',
      question: 'Two builds word this differently on the walks screen. Which should it be?',
    });
    expect(byKind.permission?.question).toBe('Two builds disagree on whether an owner can cancel walks that belong to another owner. Which is right?');
    expect(byKind.permission?.options.map((o) => o.becomes)).toEqual([
      { cannot: { persona: 'owner', text: 'cancel walks that belong to another owner' } },
      { constraint: "Any owner can cancel walks, including another owner's" },
    ]);
    expect(byKind.sort_order?.evidence.scenario_text).toBe('Ada: book walks ×7; Ada looks at walks');
    expect(
      readGaps(root)
        .map((g) => g.id)
        .sort(),
    ).toEqual(open.map((g) => g.id).sort());
    expect(readFileSync(gapPath(root, byKind.wording!.id), 'utf8')).toMatch(/^id: g_[0-9a-f]{8}\nstatus: open\nkind: wording\ntier: decided\n/);
  });

  it('routes decided gaps to people when the project says so', async () => {
    const root = project();
    const config = { ...loadConfig(root), routing: { decided: 'human' as const, declared: 'human' as const, decision_moved: 'human' as const } };
    const { open } = await raiseGaps(root, signatures, { ...opts(root), config });
    expect(open.every((g) => g.route === 'human')).toBe(true);
  });

  it('makes a gap where one side breaks the spec declared', async () => {
    const root = project();
    const sort = signatures.find((s) => s.pattern === 'sort_order')!;
    const { open } = await raiseGaps(
      root,
      signatures,
      opts(root, { contradictions: new Map([[sort.id, 'build B breaks the pinned decision "Walks are listed by starts_at, soonest first"']]) }),
    );
    expect(open.find((g) => g.id === sort.id)).toMatchObject({ tier: 'declared', route: 'human' });
  });

  it('raises nothing already answered, refreshes what is open, and removes what went away', async () => {
    const root = project();
    const first = await raiseGaps(root, signatures, opts(root));
    const answered = first.open.find((g) => g.kind === 'sort_order') as Gap;
    writeGap(root, {
      ...answered,
      status: 'applied',
      answer: { option: 'a', reason: 'soonest first is what owners plan by' },
      answered_by: 'agent:test@local',
      answered_at: '2026-10-24T12:00:00Z',
      applied_in: 'abc123',
    });
    const again = await raiseGaps(root, signatures, opts(root));
    expect(again.open.map((g) => g.kind).sort()).toEqual(['permission', 'wording']);
    expect(again.settled.map((g) => g.id)).toEqual([answered.id]);
    expect(again.superseded).toEqual([]);

    const fewer = await raiseGaps(
      root,
      signatures.filter((s) => s.pattern !== 'wording'),
      opts(root),
    );
    expect(fewer.superseded).toHaveLength(1);
    expect(
      readGaps(root)
        .map((g) => g.kind)
        .sort(),
    ).toEqual(['permission', 'sort_order']);
  });

  it('never raises an ignored difference', async () => {
    const root = project();
    const wording = signatures.find((s) => s.pattern === 'wording')!;
    addIgnore(root, { id: wording.id, reason: 'not a real difference', by: 'person:ada@example.com' });
    const { open } = await raiseGaps(root, signatures, opts(root));
    expect(open.map((g) => g.kind).sort()).toEqual(['permission', 'sort_order']);
    expect(existsSync(gapPath(root, wording.id))).toBe(false);
  });

  it('asks a model to word each question when there is one', async () => {
    const root = project();
    const model = scriptedModel({
      'word gap': (ask: { prompt: string }) =>
        ask.prompt.includes('Kind of difference: sort_order')
          ? {
              question: 'Which order should owners see their walks in?',
              a: 'Soonest first',
              b: 'Newest booked first',
              options: [
                { id: 'a', label: 'Soonest first', becomes: { decision: 'Walks are listed by starts_at, soonest first' } },
                { id: 'b', label: 'Newest booked first', becomes: { decision: 'Walks are listed newest booked first' } },
              ],
            }
          : { nonsense: true },
    });
    const { open } = await raiseGaps(root, signatures, opts(root, { model }));
    const sort = open.find((g) => g.kind === 'sort_order');
    expect(sort?.question).toBe('Which order should owners see their walks in?');
    expect(sort?.options.map((o) => o.id)).toEqual(['a', 'b', 'dont_care']);
    // An answer that doesn't fit falls back to the template.
    expect(open.find((g) => g.kind === 'wording')?.question).toMatch(/^Two builds word this differently/);
  });

  it('hashes content without the answer, for the inbox', async () => {
    const root = project();
    const { open } = await raiseGaps(root, signatures, opts(root));
    const g = open[0] as Gap;
    expect(contentHash({ ...g, status: 'answered', answer: { option: 'a' }, answered_by: 'person:x' })).toBe(contentHash(g));
    expect(contentHash({ ...g, question: 'Something else?' })).not.toBe(contentHash(g));
  });

  it('describes a scenario in plain words', () => {
    const s = scenarios.find((x) => x.id === 'journey/first-booking')!;
    expect(describeScenario(s, 2, vocab)).toBe(
      '[2026-11-02 08:00] Ada: book walks (walker Sam, starts_at 2026-11-03T09:00:00Z, minutes 30); Sam: accept or decline walks (walk $walk_1), then Ada looks at walk; [2026-11-02 18:00] Ada: cancel their own walks (walk $walk_1)',
    );
  });
});
