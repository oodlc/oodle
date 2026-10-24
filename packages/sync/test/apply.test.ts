import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGap, readIgnore } from '@oodle/gaps';
import { loadSpec } from '@oodle/spec';
import { describe, expect, it } from 'vitest';
import { AnswerRefused, applyAnswer, recordApplied } from '../src/index.ts';
import { log, PERMISSION, repo, SORT, WORDING, withGaps } from './helpers.ts';

describe('applyAnswer', () => {
  it('writes the decision an option becomes, marks the gap applied and commits', () => {
    const root = repo();
    withGaps(root, WORDING);
    const out = applyAnswer(root, WORDING.id, { option: 'a', reason: 'it is what most apps say' }, 'agent:claude@local');
    expect(out.changed.sort()).toEqual(['oodle/decisions.yaml', `oodle/gaps/${WORDING.id}.yaml`]);
    expect(out.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(log(root)[0]).toBe(`oodle: apply ${WORDING.id} (agent:claude@local)`);
    const d = loadSpec(root).spec.decisions.at(-1);
    expect(d).toMatchObject({ text: 'An empty walk list says "No walks yet."', source: 'generator', status: 'pinned', from_gap: WORDING.id });
    expect(readGap(root, WORDING.id)).toMatchObject({ status: 'applied', answered_by: 'agent:claude@local', answer: { option: 'a' } });
    recordApplied(root, [{ gap: WORDING.id, sha: out.sha as string }]);
    expect(readGap(root, WORDING.id)?.applied_in).toBe(out.sha);
    expect(log(root)[0]).toBe(`oodle: record where ${WORDING.id} was applied`);
  });

  it('replaces the decision an option names, keeping its id', () => {
    const root = repo();
    withGaps(root, SORT);
    const before = loadSpec(root).spec.decisions.find((d) => d.text.startsWith('Walks are listed'));
    applyAnswer(root, SORT.id, { option: 'b' }, 'person:ada@example.com');
    const after = loadSpec(root).spec.decisions.find((d) => d.id === before?.id);
    expect(after).toMatchObject({ text: 'Walks are listed newest booked first', source: 'person', answered_by: 'person:ada@example.com', from_gap: SORT.id });
  });

  it("writes a person's declared-tier answer with a comment saying who, and refuses an agent's", () => {
    const root = repo();
    withGaps(root, { ...PERMISSION, route: 'agent' });
    expect(() => applyAnswer(root, PERMISSION.id, { option: 'a' }, 'agent:claude@local')).toThrow(/changes the declared tier, which only a person may do/);
    applyAnswer(root, PERMISSION.id, { option: 'a' }, 'person:ada@example.com');
    expect(loadSpec(root).spec.personas.owner?.cannot).toEqual(['cancel walks that belong to another owner']);
    expect(readFileSync(join(root, 'oodle/personas.yaml'), 'utf8')).toContain(`  cannot:\n    - cancel walks that belong to another owner\n`);
  });

  it('refuses an agent on a gap routed to people', () => {
    const root = repo();
    withGaps(root, PERMISSION);
    expect(() => applyAnswer(root, PERMISSION.id, { option: 'b' }, 'agent:claude@local')).toThrow(AnswerRefused);
  });

  it('writes a constraint a person chose, and free text where its target says', () => {
    const root = repo();
    withGaps(root, PERMISSION, WORDING);
    applyAnswer(root, PERMISSION.id, { option: 'b' }, 'person:ada@example.com');
    expect(readFileSync(join(root, 'oodle/constraints.yaml'), 'utf8')).toMatch(
      /# from g_00000002, answered by person:ada@example.com\n- Any owner can cancel walks, including another owner's\n$/,
    );
    applyAnswer(root, WORDING.id, { text: 'Empty lists say what to do next', target: 'decision' }, 'person:ada@example.com');
    expect(loadSpec(root).spec.decisions.at(-1)).toMatchObject({ text: 'Empty lists say what to do next', status: 'rule', source: 'person' });
  });

  it('writes a free-text domain rule onto the gap’s entity', () => {
    const root = repo();
    withGaps(root, PERMISSION);
    applyAnswer(root, PERMISSION.id, { text: 'Only the owner of a walk can cancel it', target: 'domain_rule' }, 'person:ada@example.com');
    expect(loadSpec(root).spec.domain.walk?.rules.at(-1)).toBe('Only the owner of a walk can cancel it');
  });

  it('records "either is fine" as a dont_care decision, and "not a real difference" in the ignore list', () => {
    const root = repo();
    withGaps(root, SORT, WORDING);
    applyAnswer(root, WORDING.id, { dont_care: true }, 'person:ada@example.com');
    expect(loadSpec(root).spec.decisions.at(-1)).toMatchObject({ status: 'dont_care', from_gap: WORDING.id });
    applyAnswer(root, SORT.id, { dismiss: true }, 'person:ada@example.com');
    expect(readIgnore(root)).toEqual([{ id: SORT.id, reason: 'not a real difference', by: 'person:ada@example.com' }]);
    expect(readGap(root, SORT.id)?.status).toBe('dismissed');
  });

  it("lets a person's answer replace an agent's, keeping the first in history, and never the other way", () => {
    const root = repo();
    withGaps(root, WORDING);
    applyAnswer(root, WORDING.id, { option: 'a', reason: 'common' }, 'agent:claude@local');
    applyAnswer(root, WORDING.id, { option: 'b' }, 'person:ada@example.com');
    const g = readGap(root, WORDING.id);
    expect(g?.history?.map((h) => h.answered_by)).toEqual(['agent:claude@local']);
    expect(
      loadSpec(root)
        .spec.decisions.filter((d) => d.from_gap === WORDING.id)
        .map((d) => d.text),
    ).toEqual(['An empty walk list says "Nothing booked yet."']);
    expect(() => applyAnswer(root, WORDING.id, { option: 'a', reason: 'x' }, 'agent:claude@local')).toThrow(/a person's answer always wins/);
  });

  it('does nothing when the same inbox answer arrives twice', () => {
    const root = repo();
    withGaps(root, WORDING);
    applyAnswer(root, WORDING.id, { option: 'a', id: 'a_1' }, 'person:ada@example.com');
    const commits = log(root).length;
    expect(applyAnswer(root, WORDING.id, { option: 'a', id: 'a_1' }, 'person:ada@example.com').already).toBe(true);
    expect(log(root)).toHaveLength(commits);
  });
});

describe('a refused answer', () => {
  it('writes nothing', () => {
    const root = repo();
    const mixed = {
      ...WORDING,
      id: 'g_00000009',
      options: [{ id: 'a', label: 'x', becomes: { decision: 'Owners see "Only walkers can do this."', cannot: { persona: 'owner', text: 'decline walks' } } }],
    };
    withGaps(root, mixed);
    const before = readFileSync(join(root, 'oodle/decisions.yaml'), 'utf8');
    expect(() => applyAnswer(root, mixed.id, { option: 'a', reason: 'x' }, 'agent:claude@local')).toThrow(/only a person may do/);
    expect(readFileSync(join(root, 'oodle/decisions.yaml'), 'utf8')).toBe(before);
    expect(readGap(root, mixed.id)?.status).toBe('open');
  });
});
