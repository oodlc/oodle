import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Decision, loadSpec, specHash, writeConstraints, writeDecisions } from '../src/index.ts';
import { copyProject, DOGWALK, edit, README_EXAMPLE, read } from './helpers.ts';

describe('writeDecisions', () => {
  it('writes bare decisions back in long form, keeping every comment in the file', () => {
    const root = copyProject(README_EXAMPLE);
    const loaded = loadSpec(root);
    const before = read(root, 'spec.yaml');
    writeDecisions(loaded, loaded.spec.decisions);
    const after = read(root, 'spec.yaml');

    // Everything above decisions is untouched, byte for byte.
    expect(after.slice(0, after.indexOf('decisions:'))).toBe(before.slice(0, before.indexOf('decisions:')));
    expect(after).toContain('# written by the generator, pinned');
    const [first] = loaded.spec.decisions;
    expect(after).toContain(`  - id: ${first?.id}\n    text: Walks are listed by starts_at, soonest first\n    source: generator\n    status: pinned\n`);

    const reloaded = loadSpec(root);
    expect(reloaded.spec.decisions).toEqual(loaded.spec.decisions);
    expect(specHash(reloaded.spec)).toBe(specHash(loaded.spec));
  });

  it('is idempotent: writing what is there changes nothing', () => {
    const root = copyProject(DOGWALK);
    writeDecisions(loadSpec(root), loadSpec(root).spec.decisions);
    const once = read(root, 'decisions.yaml');
    writeDecisions(loadSpec(root), loadSpec(root).spec.decisions);
    expect(read(root, 'decisions.yaml')).toBe(once);
  });

  it('changes a decision in place, keeping the comment on it', () => {
    const root = copyProject(DOGWALK);
    writeDecisions(loadSpec(root), loadSpec(root).spec.decisions);
    edit(root, 'decisions.yaml', (t) => t.replace(/(- id: d_\w+\n {2}text: Prices)/, '# Ada asked for this in March\n$1'));
    const loaded = loadSpec(root);
    const changed = loaded.spec.decisions.map(
      (d): Decision => (d.text.startsWith('Prices') ? { ...d, source: 'person', status: 'rule', answered_by: 'person:ada@example.com' } : d),
    );
    writeDecisions(loaded, changed);
    const text = read(root, 'decisions.yaml');
    expect(text).toMatch(
      /# Ada asked for this in March\n- id: d_\w+\n {2}text: Prices are shown in the owner's currency, two decimals\n {2}source: person\n {2}status: rule\n {2}answered_by: person:ada@example.com\n/,
    );
    expect(loadSpec(root).spec.decisions).toEqual(changed);
  });

  it('adds, removes and reorders', () => {
    const root = copyProject(DOGWALK);
    const loaded = loadSpec(root);
    const [a, b, c] = loaded.spec.decisions as [Decision, Decision, Decision];
    const added: Decision = {
      id: 'd_paging',
      text: 'Owners see 20 walks per page',
      about: ['entity:walk', 'screen:walks'],
      source: 'generator',
      status: 'pinned',
      created_by_build: '9c1e44ab-1',
    };
    writeDecisions(loaded, [c, added, a]);
    expect(read(root, 'decisions.yaml')).toContain('  about: [entity:walk, screen:walks]\n');
    expect(loadSpec(root).spec.decisions).toEqual([c, added, a]);
    expect(read(root, 'decisions.yaml')).not.toContain(b.text);
    expect(read(root, 'decisions.yaml')).toMatch(/^# Written by the generator/);
  });

  it('creates decisions.yaml when the spec has none yet', () => {
    const root = copyProject(DOGWALK);
    rmSync(join(root, 'oodle/decisions.yaml'));
    const loaded = loadSpec(root);
    writeDecisions(loaded, [{ id: 'd_x', text: 'Walks are listed soonest first', about: [], source: 'generator', status: 'pinned' }]);
    expect(existsSync(join(root, 'oodle/decisions.yaml'))).toBe(true);
    expect(loadSpec(root).spec.decisions.map((d) => d.text)).toEqual(['Walks are listed soonest first']);
  });

  it('works on a section keyed by its name', () => {
    const root = copyProject(DOGWALK);
    edit(root, 'decisions.yaml', (t) => t.replace(/^- /gm, '  - ').replace(/(# A person.*\n)/, '$1decisions:\n'));
    const loaded = loadSpec(root);
    writeDecisions(loaded, loaded.spec.decisions);
    expect(read(root, 'decisions.yaml')).toMatch(/\ndecisions:\n {2}- id: d_/);
    expect(loadSpec(root).spec.decisions).toEqual(loaded.spec.decisions);
  });
});

describe('writeConstraints', () => {
  it('writes a classified constraint in long form and leaves the others as they were', () => {
    const root = copyProject(DOGWALK);
    const loaded = loadSpec(root);
    const before = read(root, 'constraints.yaml');
    writeConstraints(
      loaded,
      loaded.spec.constraints.map((c) => (c.text.startsWith('Booking answers') ? { ...c, check: 'production' as const } : c)),
    );
    const after = read(root, 'constraints.yaml');
    expect(after).toContain("- No one sees another owner's address\n");
    expect(after).toContain('- Runs on Cloudflare Workers with D1                   # the stack is a constraint when you care\n');
    expect(after).toContain('- text: Booking answers within 300 ms at p95 in production # checked in production, reported only\n  check: production\n');
    expect(after.split('\n')[0]).toBe(before.split('\n')[0]);
    expect(loadSpec(root).spec.constraints.find((c) => c.check)?.check).toBe('production');
  });
});
