import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertDeclaredUnchanged, declaredDiff, loadSpec, TierViolation } from '../src/index.ts';
import { copyProject, DOGWALK, edit, write } from './helpers.ts';

/** What the guard says about one change to a scratch copy of the example. */
function guard(change: (root: string) => void): string[] {
  const root = copyProject(DOGWALK);
  const before = loadSpec(root).spec;
  change(root);
  return declaredDiff(before, loadSpec(root).spec);
}

describe('the tier guard', () => {
  it('passes when the declared tier is the same, whatever the comments say', () => {
    expect(guard((root) => edit(root, 'domain.yaml', (t) => t.replace('# The things', '# All the things')))).toEqual([]);
  });

  it('lets decisions change: they are the decided tier', () => {
    expect(guard((root) => edit(root, 'decisions.yaml', (t) => `${t}- Walkers see their earnings per week\n`))).toEqual([]);
  });

  it.each<[string, (root: string) => void, RegExp]>([
    ['the intent reworded', (r) => edit(r, 'intent.yaml', (t) => t.replace('under a minute', 'under two minutes')), /^intent: /],
    [
      'a capability added',
      (r) => edit(r, 'personas.yaml', (t) => t.replace('rate a walker]', 'rate a walker, tip a walker]')),
      /^personas.owner.can: 1 added, "tip a walker"/,
    ],
    [
      'a cannot added',
      (r) => edit(r, 'personas.yaml', (t) => t.replace('see their earnings]', 'see their earnings]\n  cannot: [see owner addresses]')),
      /^personas.walker.cannot added/,
    ],
    ['a persona removed', (r) => edit(r, 'personas.yaml', (t) => t.replace(/walker:\n.*\n/, '')), /^personas.walker removed/],
    ['a field allowed a new value', (r) => edit(r, 'domain.yaml', (t) => t.replace('[30, 60]', '[30, 60, 90]')), /^domain.walk.fields.minutes: 1 added, 90/],
    ['a state added', (r) => edit(r, 'domain.yaml', (t) => t.replace('| cancelled', '| cancelled | no_show')), /^domain.walk.states: /],
    ['a rule edited', (r) => edit(r, 'domain.yaml', (t) => t.replace('2 hours', '3 hours')), /^domain.walk.rules\[1\]: /],
    ['an entity added', (r) => edit(r, 'domain.yaml', (t) => `${t}rating:\n  fields: { stars: [1, 2, 3, 4, 5] }\n`), /^domain.rating added/],
    ['a journey step edited', (r) => edit(r, 'journeys/first-booking.yaml', (t) => t.replace('$20', '$25')), /^journeys.first-booking.steps\[0\]: /],
    [
      'a journey persona changed',
      (r) => edit(r, 'journeys/first-booking.yaml', (t) => t.replace('persona: owner', 'persona: walker')),
      /^journeys.first-booking.persona: "owner" → "walker"/,
    ],
    ['a journey added', (r) => write(r, 'journeys/earnings.yaml', 'persona: walker\nsteps:\n  - Sam opens earnings\n'), /^journeys.earnings added/],
    ['a journey removed', (r) => rmSync(join(r, 'oodle/journeys/first-booking.yaml')), /^journeys.first-booking removed/],
    ['a constraint removed', (r) => edit(r, 'constraints.yaml', (t) => t.replace("- No one sees another owner's address\n", '')), /^constraints/],
    [
      'a constraint classified',
      (r) =>
        edit(r, 'constraints.yaml', (t) => t.replace("- No one sees another owner's address", "- { text: No one sees another owner's address, check: build }")),
      /^constraints\[1\].check added/,
    ],
  ])('catches %s', (_what, change, says) => {
    const changes = guard(change);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toMatch(says);
  });

  it('throws a TierViolation listing every change', () => {
    const root = copyProject(DOGWALK);
    const before = loadSpec(root).spec;
    edit(root, 'domain.yaml', (t) => t.replace('2 hours', '3 hours'));
    edit(root, 'intent.yaml', (t) => t.replace('under a minute', 'quickly'));
    const after = loadSpec(root).spec;
    expect(() => assertDeclaredUnchanged(before, before)).not.toThrow();
    expect(() => assertDeclaredUnchanged(before, after)).toThrow(TierViolation);
    try {
      assertDeclaredUnchanged(before, after);
    } catch (e) {
      expect((e as TierViolation).changes).toHaveLength(2);
      expect((e as Error).message).toMatch(/Only people change the declared tier/);
    }
  });
});
