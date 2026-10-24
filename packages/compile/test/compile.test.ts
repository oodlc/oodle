import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '@oodle/spec';
import { describe, expect, it } from 'vitest';
import { actionOf, compile, explorationPlan, readCompiled, scriptedModel, splitCapability, vocabularyOf } from '../src/index.ts';
import { DOGWALK_ANSWERS, dogwalkModel } from './dogwalk-answers.ts';

const DOGWALK = join(import.meta.dirname, '../../../examples/dogwalk');

function copy() {
  const root = mkdtempSync(join(tmpdir(), 'oodle-compile-'));
  cpSync(join(DOGWALK, 'oodle'), join(root, 'oodle'), { recursive: true });
  return root;
}

describe('the vocabulary', () => {
  it('turns capabilities into actions', () => {
    expect(splitCapability('accept or decline walks')).toEqual(['accept walks', 'decline walks']);
    expect(actionOf('owner', 'cancel their own walks', ['walk'])).toMatchObject({ id: 'owner.cancel_walk', entity: 'walk', inputs: ['walk'] });
    expect(actionOf('owner', 'book walks', ['walk'])).toMatchObject({ id: 'owner.book_walk', creates: true, inputs: [] });
    expect(actionOf('walker', 'see their earnings', ['walk'])).toMatchObject({ id: 'walker.see_earnings', inputs: [] });
  });

  it('gives dogwalk its actions and screens', () => {
    const v = vocabularyOf(loadSpec(DOGWALK).spec);
    expect(v.actions.map((a) => a.id)).toEqual([
      'owner.book_walk',
      'owner.cancel_walk',
      'owner.rate_walker',
      'walker.set_availability',
      'walker.accept_walk',
      'walker.decline_walk',
      'walker.see_earnings',
    ]);
    expect(v.screens.map((s) => `${s.name}(${s.params.join(',')})`)).toEqual(['home()', 'walks()', 'walk(walk)']);
  });
});

describe('oodle compile', () => {
  it('is up to date for examples/dogwalk', async () => {
    expect(await compile(DOGWALK, { check: true })).toMatchObject({ stale: [], compiled: [] });
  });

  it('asks the model nothing when nothing changed, and only about what did', async () => {
    const root = copy();
    const model = dogwalkModel();
    expect((await compile(root, { model })).written).toEqual([]);
    expect(model.asked).toEqual([]);

    const path = join(root, 'oodle/journeys/first-booking.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('$20', '$25'));
    const answers = {
      ...DOGWALK_ANSWERS,
      'compile journey first-booking': JSON.parse(JSON.stringify(DOGWALK_ANSWERS['compile journey first-booking']).replace('$20', '$25')),
    };
    const again = scriptedModel(answers as never, 'recorded');
    const result = await compile(root, { model: again });
    expect(again.asked).toEqual(['compile journey first-booking']);
    // The exploration plan takes its sample inputs from journeys, so it is rewritten too.
    expect(result.written.map((p) => p.slice(root.length))).toEqual(['/oodle/compiled/explore.json', '/oodle/compiled/journeys/first-booking.json']);
    expect(await compile(root, { check: true })).toMatchObject({ stale: [] });
  });

  it('says what is stale without a model', async () => {
    const root = copy();
    const path = join(root, 'oodle/decisions.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}- Walkers see their earnings per week\n`);
    const result = await compile(root, { check: true });
    expect(result.stale).toEqual(['check "Walkers see their earnings per week"']);
    await expect(compile(root)).rejects.toThrow('check "Walkers see their earnings per week" needs a model, and none is configured');
  });

  it('asks the model again when its answer does not fit the vocabulary, then gives up', async () => {
    const root = copy();
    rmSync(join(root, 'oodle/compiled/journeys/first-booking.json'));
    const bad = { scenario: { id: 'x', fixtures: { 'owner:ada': { name: 'Ada' } }, steps: [{ line: 0, as: 'owner:ada', do: 'owner.fly_to_the_moon' }] } };
    const model = scriptedModel({ 'compile journey': bad });
    await expect(compile(root, { model })).rejects.toThrow(/no action "owner.fly_to_the_moon".*line 1 has no step/);
    expect(model.asked).toEqual(['compile journey first-booking', 'compile journey first-booking']);
  });

  it('removes compiled files for what the spec no longer has', async () => {
    const root = copy();
    const path = join(root, 'oodle/decisions.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/- Declining a walk.*\n/, ''));
    const result = await compile(root, { model: dogwalkModel() });
    expect(result.written.map((p) => p.slice(root.length))).toEqual(['/oodle/compiled/checks/d_e9c8b22e.json']);
    expect(readCompiled(root).checks).toHaveLength(4);
  });
});

describe('the exploration plan', () => {
  it('is the same plan every time, and covers each kind', () => {
    const spec = loadSpec(DOGWALK).spec;
    const c = readCompiled(DOGWALK);
    const plan = explorationPlan(spec, c.vocabulary!, c.journeys);
    expect(JSON.stringify(plan)).toBe(JSON.stringify(explorationPlan(spec, c.vocabulary!, c.journeys)));
    expect(plan.planned).toEqual({ collections: 4, permissions: 15, states: 9, rules: 3, fields: 9 });
    expect(plan.scenarios.map((s) => s.id)).toContain('explore/rules/walk-1-at');
    expect(Object.keys(plan.scenarios[0]?.fixtures ?? {})).toEqual(['owner:ada', 'walker:sam', 'owner:bea', 'walker:cal']);
    expect(plan.scenarios[0]?.fixtures['owner:bea']).toEqual({ name: 'Bea', address: '17 Elm St' });
    const rule = plan.scenarios.find((s) => s.id === 'explore/rules/walk-1-at');
    expect(rule?.steps[1]).toMatchObject({ at: '2026-11-03T07:00:00Z', as: 'owner:ada', do: 'owner.cancel_walk' });
  });

  it('keeps to its cap', () => {
    const spec = loadSpec(DOGWALK).spec;
    const c = readCompiled(DOGWALK);
    expect(explorationPlan(spec, c.vocabulary!, c.journeys, { cap: 5 }).scenarios.map((s) => s.id)).toEqual([
      'explore/collections/walks-0',
      'explore/collections/walks-1',
      'explore/collections/walks-7',
      'explore/collections/walks-60',
      'explore/permissions/owner.book_walk/walker:sam',
    ]);
  });
});
