import { describe, expect, it } from 'vitest';
import { loadSpec, specHash } from '../src/index.ts';
import { copyProject, DOGWALK, edit, README_EXAMPLE } from './helpers.ts';

/** The hash before and after an edit to a scratch copy of the example. */
function hashes(file: string, fn: (text: string) => string, from = DOGWALK, tiers?: ('declared' | 'decided')[]) {
  const root = copyProject(from);
  const before = specHash(loadSpec(root).spec, { tiers });
  edit(root, file, fn);
  return [before, specHash(loadSpec(root).spec, { tiers })];
}

describe('specHash', () => {
  it('is a sha-256 that stays the same across loads', () => {
    expect(specHash(loadSpec(DOGWALK).spec)).toMatch(/^[0-9a-f]{64}$/);
    expect(specHash(loadSpec(DOGWALK).spec)).toBe(specHash(loadSpec(DOGWALK).spec));
  });

  it.each([
    ['a comment edited', 'personas.yaml', (t: string) => t.replace('# Who uses the app', '# Who might use the app')],
    ['a comment added', 'domain.yaml', (t: string) => t.replace('  rules:', '  rules: # see the cancellation policy')],
    [
      'flow style turned to block style',
      'personas.yaml',
      (t: string) =>
        t.replace('can: [book walks, cancel their own walks, rate a walker]', 'can:\n    - book walks\n    - cancel their own walks\n    - rate a walker'),
    ],
    ['personas reordered', 'personas.yaml', (t: string) => t.replace(/(owner:\n.*\n)(walker:\n.*\n)/, '$2$1')],
    [
      'a string quoted',
      'decisions.yaml',
      (t: string) => t.replace('- Walks are listed by starts_at, soonest first', '- "Walks are listed by starts_at, soonest first"'),
    ],
  ])("doesn't change for %s", (_what, file, fn) => {
    const [before, after] = hashes(file, fn);
    expect(after).toBe(before);
  });

  it.each([
    ['a journey step edited', 'journeys/first-booking.yaml', (t: string) => t.replace('$20', '$25')],
    ['a persona capability added', 'personas.yaml', (t: string) => t.replace('rate a walker]', 'rate a walker, tip a walker]')],
    ['a domain rule edited', 'domain.yaml', (t: string) => t.replace('2 hours', '3 hours')],
    [
      'a constraint classified',
      'constraints.yaml',
      (t: string) => t.replace("- No one sees another owner's address", "- { text: No one sees another owner's address, check: build }"),
    ],
    ['a decision added', 'decisions.yaml', (t: string) => `${t}- A walker sees at most 20 walks per page\n`],
  ])('changes for %s', (_what, file, fn) => {
    const [before, after] = hashes(file, fn);
    expect(after).not.toBe(before);
  });

  it('can cover one tier: a decision added leaves the declared hash alone', () => {
    const [before, after] = hashes('decisions.yaml', (t) => `${t}- A walker sees at most 20 walks per page\n`, DOGWALK, ['declared']);
    expect(after).toBe(before);
  });

  it("doesn't change for who wrote a decision, only for what it says", () => {
    const root = copyProject(README_EXAMPLE);
    const before = specHash(loadSpec(root).spec);
    const [first] = loadSpec(root).spec.decisions;
    edit(root, 'spec.yaml', (t) =>
      t.replace(
        '  - Walks are listed by starts_at, soonest first',
        `  - { id: ${first?.id}, text: "Walks are listed by starts_at, soonest first", source: person, status: pinned, answered_by: "person:ada@example.com", from_gap: g_1 }`,
      ),
    );
    expect(specHash(loadSpec(root).spec)).toBe(before);
  });
});
