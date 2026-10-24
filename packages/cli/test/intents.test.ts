import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptedModel } from '@oodle/compile';
import { loadSpec, readIntents } from '@oodle/spec';
import { describe, expect, it } from 'vitest';
import { DOGWALK_ANSWERS } from '../../compile/test/dogwalk-answers.ts';
import { CANCEL_FEE, DOGWALK_A, variant } from '../../sim/test/fixtures/variants.ts';
import { verifyCommand } from '../src/commands/basics.ts';
import { intentApprove, intentMerge, intentReview, mergedIntents, pendingIntents } from '../src/commands/intents.ts';
import { type Ctx, context, NeedsPerson } from '../src/context.ts';
import { git, project } from './helpers.ts';

const INTENT = `id: i_cancel_fee
title: Charge half price for late cancellations
status: draft
why: Walkers lose income on late cancellations.
changes:
  - op: replace_rule
    entity: walk
    from: "An owner can cancel for free until 2 hours before starts_at"
    to: "An owner can cancel for free until 2 hours before starts_at; after that they pay 50%"
  - op: add_journey
    journey: late-cancellation
    persona: owner
    steps:
      - 'Ada books Sam for Tuesday 9:00, 30 minutes, and Sam accepts'
      - 'Ada cancels on Tuesday at 8:00: she sees "Cancelled, charged $10.00"'
keeps:
  journeys: [first-booking]
  constraints: ["An owner is never charged for a walk that didn't happen"]
rules_out: [new_dependencies, new_outbound_hosts, new_routes]
done_when:
  journeys: [late-cancellation]
  evals: []
approvals: []
`;

const fixtures = { 'owner:ada': { name: 'Ada', address: '1 Elm St' }, 'walker:sam': { name: 'Sam' } };
/** The dogwalk answers, plus what the changed spec needs: the new journey, and the charge constraint read against the new rule. */
const model = () =>
  scriptedModel(
    {
      ...DOGWALK_ANSWERS,
      'compile journey late-cancellation': {
        scenario: {
          id: 'journey/late-cancellation',
          fixtures,
          steps: [
            {
              line: 0,
              at: '2026-11-02T08:00:00Z',
              as: 'owner:ada',
              do: 'owner.book_walk',
              input: { walker: 'walker:sam', starts_at: '2026-11-03T09:00:00Z', minutes: 30 },
            },
            { line: 0, as: 'walker:sam', do: 'walker.accept_walk', input: { walk: '$walk_1' } },
            {
              line: 1,
              at: '2026-11-03T08:00:00Z',
              as: 'owner:ada',
              do: 'owner.cancel_walk',
              input: { walk: '$walk_1' },
              expect: { screen_contains: ['Cancelled, charged $10.00'] },
            },
          ],
        },
      },
      'compile check c_': (ask: { prompt: string }) =>
        ask.prompt.slice(ask.prompt.lastIndexOf('## The ')).includes("another owner's address")
          ? { check: { kind: 'never_shows_field', field: 'address', viewers: ['owner'], owners: ['owner'] } }
          : { check: { kind: 'never_matches', pattern: 'declined[^\\n]*charged \\$', viewers: ['owner'] } },
    } as never,
    'recorded',
  );

function ctxFor(root: string, person: boolean): Ctx {
  const m = model();
  return { ...context({ root }), tty: person, model: () => m, print: () => {} };
}

describe('an intent, from draft to a verified build', () => {
  it('reviews, needs a person to approve, goes stale when edited, merges, and adds its checks to verify', async () => {
    const root = project();
    mkdirSync(join(root, 'oodle/intents'));
    writeFileSync(join(root, 'oodle/intents/2026-11-cancel-fee.yaml'), INTENT);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'intent: cancel fee');
    const app = variant(CANCEL_FEE);

    // Review: the change built twice (here, the same hand-written build), diffed where it reaches.
    expect(await intentReview(ctxFor(root, false), 'i_cancel_fee', { a: app, b: app })).toBe(0);
    expect(readIntents(root)[0]?.intent.status).toBe('in_review');

    // Agents can't approve.
    expect(() => intentApprove(ctxFor(root, false), 'i_cancel_fee', {})).toThrow(NeedsPerson);
    intentApprove(ctxFor(root, true), 'i_cancel_fee', {});
    expect(readIntents(root)[0]?.intent).toMatchObject({ status: 'approved', approvals: [{ by: 'person:ada@example.com', via: 'cli', decision: 'approve' }] });

    // Editing it after approval makes the approval stale.
    const path = join(root, 'oodle/intents/2026-11-cancel-fee.yaml');
    const approved = readFileSync(path, 'utf8');
    writeFileSync(path, approved.replace('Walkers lose income on late cancellations.', 'Walkers lose income.'));
    expect(() => intentMerge(ctxFor(root, true), 'i_cancel_fee')).toThrow(/approval is stale/);
    writeFileSync(path, approved);

    expect(intentMerge(ctxFor(root, true), 'i_cancel_fee')).toBe(0);
    expect(git(root, 'log', '--format=%s', '-1')).toBe('oodle: merge i_cancel_fee (approved by person:ada@example.com)');
    expect(loadSpec(root).spec.domain.walk?.rules[1]).toMatch(/after that they pay 50%$/);
    expect(loadSpec(root).spec.journeys.map((j) => j.id)).toEqual(['first-booking', 'late-cancellation']);
    expect(mergedIntents(ctxFor(root, false)).map((i) => i.id)).toEqual(['i_cancel_fee']);

    // The build that implements it passes, with the intent's checks; the old app fails its done_when journey.
    expect(await verifyCommand(ctxFor(root, false), app, { typecheck: false })).toBe(0);
    expect(await verifyCommand(ctxFor(root, false), DOGWALK_A, { typecheck: false })).toBe(1);
    const withDep = variant([
      ...CANCEL_FEE,
      { why: 'a dependency the intent rules out', file: 'package.json', from: '"hono": "4.13.13"', to: '"hono": "4.13.13",\n    "left-pad": "1.3.0"' },
    ]);
    expect(await verifyCommand(ctxFor(root, false), withDep, { typecheck: false })).toBe(1);
    const report = JSON.parse(readFileSync(join(root, '.oodle/verify', `${withDep.replace(/[^a-zA-Z0-9]+/g, '_').slice(-60)}/verify.json`), 'utf8'));
    expect(report.findings.filter((f: { stage: string }) => f.stage === 'intent').map((f: { message: string }) => f.message)).toEqual([
      'a new dependency, left-pad, which the intent rules out',
    ]);
  });

  it('ignores an intent that only exists on the branch being built', () => {
    const root = project();
    git(root, 'checkout', '-q', '-b', 'sneaky');
    mkdirSync(join(root, 'oodle/intents'));
    writeFileSync(
      join(root, 'oodle/intents/2026-11-sneaky.yaml'),
      'id: i_sneaky\ntitle: Approve myself\nstatus: merged\nwhy: Because.\nchanges: []\nrules_out: [new_routes]\napprovals: []\nmerged_at: "2026-11-01T00:00:00Z"\n',
    );
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'sneaky');
    const ctx = ctxFor(root, false);
    expect(readIntents(root).map((x) => x.intent.id)).toEqual(['i_sneaky']);
    expect(mergedIntents(ctx)).toEqual([]);
    expect(pendingIntents(ctx)).toEqual([]);
  });
});
