import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, SpecError, specHash } from '../src/index.ts';
import { copyProject, DOGWALK, edit, README_EXAMPLE, write } from './helpers.ts';

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SpecError) return e.problems;
    throw e;
  }
  throw new Error('expected a SpecError');
};

describe('the README example (single file)', () => {
  const { spec, layout } = loadSpec(README_EXAMPLE);

  it('loads every section', () => {
    expect(layout).toBe('single');
    expect(spec.intent).toMatch(/^Owners can book a trusted walker/);
    expect(spec.personas.owner?.can).toEqual(['book walks', 'cancel their own walks', 'rate a walker']);
    expect(spec.domain.walk?.fields).toEqual({ owner: null, walker: null, starts_at: null, minutes: [30, 60], price: null, status: null });
    expect(spec.domain.walk?.rules).toHaveLength(2);
    expect(spec.constraints.map((c) => c.text)).toContain("No one sees another owner's address");
    expect(spec.constraints.every((c) => c.check === undefined)).toBe(true);
  });

  it('reads a step YAML parsed as a one-key map back as the line it was', () => {
    expect(spec.journeys[0]?.steps).toEqual([
      'Ada opens the app, picks Sam for Tuesday 9:00, 30 minutes: she sees "Requested, $20"',
      'Sam accepts: Ada sees "Accepted" and gets an email',
      'Ada cancels on Monday at 18:00: she sees "Cancelled, no charge"',
    ]);
  });

  it('expands bare decisions into pinned generator decisions with stable ids', () => {
    expect(spec.decisions).toHaveLength(3);
    for (const d of spec.decisions) {
      expect(d).toMatchObject({ source: 'generator', status: 'pinned', about: [] });
      expect(d.id).toMatch(/^d_[0-9a-f]{8}$/);
    }
    expect(loadSpec(README_EXAMPLE).spec.decisions.map((d) => d.id)).toEqual(spec.decisions.map((d) => d.id));
  });
});

describe('the split layout', () => {
  it('loads examples/dogwalk to the same spec as the README example', () => {
    const split = loadSpec(DOGWALK);
    expect(split.layout).toBe('split');
    expect(split.spec.journeys.map((j) => j.id)).toEqual(['first-booking']);
    expect(specHash(split.spec)).toBe(specHash(loadSpec(README_EXAMPLE).spec));
  });

  it('accepts a section file with or without its section key', () => {
    const root = copyProject(DOGWALK);
    const before = specHash(loadSpec(root).spec);
    edit(root, 'intent.yaml', (t) => t.replace('intent: ', ''));
    expect(specHash(loadSpec(root).spec)).toBe(before);
  });

  it('loads an empty spec folder as an empty spec', () => {
    const root = mkdtempSync(join(tmpdir(), 'oodle-spec-'));
    mkdirSync(join(root, 'oodle'));
    expect(loadSpec(root).spec).toEqual({ personas: {}, domain: {}, journeys: [], constraints: [], decisions: [] });
  });

  it('takes a journey id from its file name, and refuses one that disagrees', () => {
    const root = copyProject(DOGWALK);
    edit(root, 'journeys/first-booking.yaml', (t) => `id: first-walk\n${t}`);
    expect(problemsOf(() => loadSpec(root))).toEqual([expect.stringMatching(/journeys\/first-booking.yaml: id "first-walk" doesn't match the file name/)]);
  });
});

describe('problems', () => {
  it('needs an oodle/ folder', () => {
    expect(problemsOf(() => loadSpec(mkdtempSync(join(tmpdir(), 'oodle-spec-'))))).toEqual([expect.stringMatching(/No spec: oodle\/ does not exist/)]);
  });

  it('refuses both layouts at once', () => {
    const root = copyProject(DOGWALK);
    write(root, 'spec.yaml', 'intent: x\n');
    expect(problemsOf(() => loadSpec(root))[0]).toMatch(/has both spec.yaml and/);
  });

  it('reports every problem, each with where it is', () => {
    const root = copyProject(README_EXAMPLE);
    edit(root, 'spec.yaml', (t) => t.replace('persona: owner', 'persona: dog').replace('states: requested', 'state: requested').concat('\nscreens: {}\n'));
    const problems = problemsOf(() => loadSpec(root));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/oodle\/spec.yaml: unknown section "screens"/),
        expect.stringMatching(/oodle\/spec.yaml: domain: walk: Unrecognized key: "state"/),
        expect.stringMatching(/journeys: first-booking: persona "dog" isn't one of the personas \(owner, walker\)/),
      ]),
    );
  });

  it('reports YAML syntax errors with the file', () => {
    const root = copyProject(DOGWALK);
    write(root, 'domain.yaml', 'walk:\n  fields: { owner\n');
    expect(problemsOf(() => loadSpec(root))[0]).toMatch(/^oodle\/domain.yaml: /);
  });

  it('refuses a step that is a map of more than one key', () => {
    const root = copyProject(DOGWALK);
    write(root, 'journeys/first-booking.yaml', 'persona: owner\nsteps:\n  - { a: b, c: d }\n');
    expect(problemsOf(() => loadSpec(root)).join('\n')).toMatch(/quote it if it contains ": "/);
  });

  it('refuses two decisions with the same id', () => {
    const root = copyProject(DOGWALK);
    edit(root, 'decisions.yaml', (t) => `${t}- Walks are listed by starts_at,   soonest first\n`);
    expect(problemsOf(() => loadSpec(root))).toEqual([expect.stringMatching(/decisions: "d_[0-9a-f]+" is used by more than one decision/)]);
  });
});
