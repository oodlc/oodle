import { join } from 'node:path';
import { readCompiled } from '@oodle/compile';
import { loadBuild, runScenarios, type Scenario } from '@oodle/sim';
import { describe, expect, it } from 'vitest';
import { DOGWALK_A, DOGWALK_B, variant } from '../../sim/test/fixtures/variants.ts';
import { cluster, diffRuns, normalize } from '../src/index.ts';

const compiled = readCompiled(join(import.meta.dirname, '../../../examples/dogwalk'));
const scenarios = [...compiled.journeys.map((j) => j.scenario), ...(compiled.explore?.scenarios ?? [])] as Scenario[];
const ctx = { scenarios, entities: ['walk'], entityOf: (a: string) => compiled.vocabulary?.actions.find((x) => x.id === a)?.entity };

describe('normalize', () => {
  it('turns generated ids into symbols by first appearance', () => {
    const obs = (text: string[]) => ({
      scenario: 's',
      step: 0,
      as: 'owner:ada',
      status: 200,
      view: { headings: [], text, lists: [], actions: [], fields: [] },
      mail: [],
      outbound: [],
    });
    expect(normalize([obs(['walk_7 then walk_3', 'again walk_7', 'rating_1'])])[0]?.view.text).toEqual([
      '⟨walk#1⟩ then ⟨walk#2⟩',
      'again ⟨walk#1⟩',
      '⟨rating#1⟩',
    ]);
  });
});

describe('the gaps check on two hand-written builds', () => {
  it('finds exactly the three planted differences, with stable ids', async () => {
    const [a, b] = await Promise.all([loadBuild(DOGWALK_A), loadBuild(variant(DOGWALK_B))]);
    const [ra, rb] = await Promise.all([runScenarios(a, scenarios), runScenarios(b, scenarios)]);
    const gaps = cluster(diffRuns(ctx, ra, rb));
    expect(gaps.map((g) => `${g.pattern} ${g.where}`).sort()).toEqual([
      'permission action:owner.cancel_walk',
      'sort_order screen:walks',
      'wording screen:walks',
    ]);

    const sort = gaps.find((g) => g.pattern === 'sort_order');
    expect(sort?.evidence.scenario).toBe('explore/collections/walks-7');
    expect(sort?.about).toEqual(['entity:walk', 'screen:walks']);
    expect(sort?.scenarios).toEqual(['explore/collections/walks-7', 'explore/collections/walks-60']);

    const wording = gaps.find((g) => g.pattern === 'wording');
    expect(wording?.evidence).toMatchObject({ a: { sample: ['No walks yet.'] }, b: { sample: ['Nothing booked yet.'] } });

    const permission = gaps.find((g) => g.pattern === 'permission');
    expect(permission?.evidence).toMatchObject({
      scenario: 'explore/permissions/owner.cancel_walk/owner:bea',
      actor: 'owner:bea',
      a: { summary: 'refused' },
      b: { summary: 'allowed' },
    });

    // Same builds again: the same ids.
    const [ra2, rb2] = await Promise.all([runScenarios(a, scenarios, { parallel: 2 }), runScenarios(b, scenarios, { parallel: 3 })]);
    expect(cluster(diffRuns(ctx, ra2, rb2)).map((g) => g.id)).toEqual(gaps.map((g) => g.id));
  });

  it('finds nothing between two runs of the same build', async () => {
    const a = await loadBuild(DOGWALK_A);
    const [ra, rb] = await Promise.all([runScenarios(a, scenarios, { seed: 1 }), runScenarios(a, scenarios, { seed: 2 })]);
    expect(cluster(diffRuns(ctx, ra, rb))).toEqual([]);
  });

  it('leaves out what is ignored', async () => {
    const [a, b] = await Promise.all([loadBuild(DOGWALK_A), loadBuild(variant(DOGWALK_B))]);
    const [ra, rb] = await Promise.all([runScenarios(a, scenarios), runScenarios(b, scenarios)]);
    const all = cluster(diffRuns(ctx, ra, rb));
    const wording = all.find((g) => g.pattern === 'wording')?.id as string;
    expect(
      cluster(diffRuns(ctx, ra, rb), new Set([wording]))
        .map((g) => g.pattern)
        .sort(),
    ).toEqual(['permission', 'sort_order']);
  });
});
