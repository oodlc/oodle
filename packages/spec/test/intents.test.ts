import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyChanges, type Change, currentApproval, type Intent, intentContentHash, loadSpec, writeChanges } from '../src/index.ts';
import { copyProject, DOGWALK, README_EXAMPLE, read } from './helpers.ts';

const CANCEL_FEE: Change[] = [
  {
    op: 'replace_rule',
    entity: 'walk',
    from: 'An owner can cancel for free until 2 hours before starts_at',
    to: 'An owner can cancel for free until 2 hours before starts_at; after that they pay 50%',
  },
  {
    op: 'add_journey',
    journey: 'late-cancellation',
    persona: 'owner',
    steps: ['Ada books Sam for Tuesday 9:00, 30 minutes, and Sam accepts', 'Ada cancels on Tuesday at 8:00: she sees "Cancelled, charged $10.00"'],
  },
];

describe('intent changes', () => {
  it('apply in memory', () => {
    const spec = applyChanges(loadSpec(DOGWALK).spec, CANCEL_FEE);
    expect(spec.domain.walk?.rules[1]).toMatch(/after that they pay 50%$/);
    expect(spec.journeys.map((j) => j.id)).toEqual(['first-booking', 'late-cancellation']);
  });

  it("refuse a change that doesn't fit the spec", () => {
    expect(() => applyChanges(loadSpec(DOGWALK).spec, [{ op: 'replace_rule', entity: 'walk', from: 'No such rule', to: 'x' }])).toThrow(
      'the rule "No such rule" isn\'t in the spec',
    );
  });

  it('write only the lines they name (split layout)', () => {
    const root = copyProject(DOGWALK);
    const domain = read(root, 'domain.yaml');
    writeChanges(
      root,
      [
        ...CANCEL_FEE,
        { op: 'add_persona_capability', persona: 'walker', can: 'see their ratings' },
        { op: 'add_step', journey: 'first-booking', step: 'Ada rates Sam 5 stars' },
      ],
      'from intent i_cancel_fee',
    );
    expect(read(root, 'domain.yaml')).toBe(domain.replace('before starts_at\n', 'before starts_at; after that they pay 50%\n'));
    expect(read(root, 'journeys/late-cancellation.yaml')).toMatch(/^# from intent i_cancel_fee\npersona: owner\nsteps:\n/);
    const spec = loadSpec(root).spec;
    expect(spec).toEqual(
      applyChanges(loadSpec(DOGWALK).spec, [
        ...CANCEL_FEE,
        { op: 'add_persona_capability', persona: 'walker', can: 'see their ratings' },
        { op: 'add_step', journey: 'first-booking', step: 'Ada rates Sam 5 stars' },
      ]),
    );
  });

  it('write the single-file layout too', () => {
    const root = copyProject(README_EXAMPLE);
    writeChanges(root, CANCEL_FEE, 'from intent i_cancel_fee');
    const spec = loadSpec(root).spec;
    expect(spec.journeys.map((j) => j.id)).toEqual(['first-booking', 'late-cancellation']);
    expect(readFileSync(join(root, 'oodle/spec.yaml'), 'utf8')).toContain('# checked in production, reported only');
  });
});

describe('approvals', () => {
  const intent: Intent = {
    id: 'i_cancel_fee',
    title: 'Late fee',
    status: 'in_review',
    why: 'Walkers lose income.',
    changes: CANCEL_FEE,
    keeps: { journeys: [], constraints: [] },
    rules_out: ['new_dependencies'],
    done_when: { journeys: ['late-cancellation'], evals: [] },
    approvals: [],
  };

  it('bind to the content, so editing the intent makes them stale', () => {
    const approved = {
      ...intent,
      status: 'approved' as const,
      approvals: [
        {
          by: 'person:ada@example.com',
          at: '2026-10-24T12:00:00Z',
          via: 'inbox' as const,
          decision: 'approve' as const,
          content_hash: intentContentHash(intent),
        },
      ],
    };
    expect(currentApproval(approved)?.by).toBe('person:ada@example.com');
    expect(currentApproval({ ...approved, why: 'Something else.' })).toBeUndefined();
    expect(intentContentHash({ ...intent, status: 'merged' })).toBe(intentContentHash(intent));
  });
});
