import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGaps } from '@oodle/gaps';
import { loadSpec } from '@oodle/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { DOGWALK_A, DOGWALK_B, variant } from '../../sim/test/fixtures/variants.ts';
import { git, oodle, project, scriptedAnswers } from './helpers.ts';

const B = variant(DOGWALK_B);

afterEach(() => {
  delete process.env.OODLE_SCRIPTED_MODEL;
});

describe('the local loop on two hand-written builds', () => {
  it('gaps → answer --auto settles decided gaps and stops at declared ones → gaps again raises nothing answered', async () => {
    const root = project();
    // The question writer and the tier fallback get no scripted answer, so they use their templates.
    process.env.OODLE_SCRIPTED_MODEL = scriptedAnswers(mkdtempSync(join(tmpdir(), 'oodle-ans-')), {
      'answer gap': { option: 'a', reason: 'it matches the decisions already pinned' },
      // The decisions the answers pin are compiled into checks before the next run.
      'compile check': { check: { kind: 'unchecked', reason: 'recorded for the test' } },
    });

    const first = await oodle(root, 'gaps', '--a', DOGWALK_A, '--b', B);
    expect(first.code).toBe(1);
    expect(first.out.agree).toBe(false);
    expect(first.out.open.map((g: { kind: string; route: string }) => `${g.kind}:${g.route}`).sort()).toEqual([
      'permission:human',
      'sort_order:agent',
      'wording:agent',
    ]);

    const auto = await oodle(root, 'answer', '--auto');
    expect(auto.code).toBe(3);
    expect(auto.out.settled).toHaveLength(2);
    expect(auto.out.needs_person.map((g: { kind: string }) => g.kind)).toEqual(['permission']);
    expect(git(root, 'log', '--format=%s').split('\n').slice(0, 4)).toEqual([
      expect.stringMatching(/^oodle: record where g_\w+, g_\w+ were applied$/),
      expect.stringMatching(/^oodle: apply g_\w+ \(agent:scripted@local\)$/),
      expect.stringMatching(/^oodle: apply g_\w+ \(agent:scripted@local\)$/),
      'oodle: gaps found',
    ]);
    expect(git(root, 'status', '--porcelain')).toBe('');
    const decisions = loadSpec(root).spec.decisions.filter((d) => d.from_gap);
    expect(decisions.map((d) => d.status)).toEqual(['pinned', 'pinned']);
    expect(decisions.map((d) => d.text).sort()).toEqual([
      'The walks screen says "No walks yet."',
      'Walks are listed in this order: Wed 4 Nov, 09:00 with Sam: Requested, $20.00, Thu 5 Nov, 09:00 with Sam: Requested, $20.00, Fri 6 Nov, 09:00 with Sam: Requested, $20.00…',
    ]);

    const again = await oodle(root, 'gaps', '--a', DOGWALK_A, '--b', B);
    expect(again.out.open.map((g: { kind: string }) => g.kind)).toEqual(['permission']);
    expect(again.out.settled).toHaveLength(2);

    const person = await oodle(root, 'answer', again.out.open[0].id, '--option', 'a', '--reason', 'agents may not');
    expect(person.code).toBe(3);
    expect(person.out.needs_person).toMatch(/is routed to people/);

    const status = await oodle(root, 'status');
    expect(status.out).toMatchObject({ agree: false, by_route: { human: 1, agent: 0 }, applied: 2 });
  });

  it('says the builds agree when they do, and remembers it', async () => {
    const root = project();
    const same = await oodle(root, 'gaps', '--a', DOGWALK_A, '--b', DOGWALK_A);
    expect(same).toMatchObject({ code: 0, out: { agree: true, open: [] } });
    expect((await oodle(root, 'status')).out.agree).toBe(true);
  });

  it('lets an agent answer one agent-routed gap, with a reason', async () => {
    const root = project();
    await oodle(root, 'gaps', '--a', DOGWALK_A, '--b', B);
    const wording = readGaps(root).find((g) => g.kind === 'wording');
    const noReason = await oodle(root, 'answer', wording!.id, '--option', 'b');
    expect(noReason.code).toBe(2);
    const ok = await oodle(root, 'answer', wording!.id, '--option', 'b', '--reason', 'friendlier');
    expect(ok.code).toBe(0);
    expect(readFileSync(join(root, 'oodle/decisions.yaml'), 'utf8')).toContain('Nothing booked yet.');
  });
});

describe('the other commands', () => {
  it('compile --check is up to date on the example', async () => {
    expect((await oodle(project(), 'compile', '--check')).code).toBe(0);
  });

  it('verify passes fixture A and fails dogwalk-b on the decision it moved', async () => {
    const root = project();
    expect((await oodle(root, 'verify', DOGWALK_A, '--no-typecheck')).out).toMatchObject({ passed: true, journeys: { 'first-booking': true } });
    const b = await oodle(root, 'verify', B, '--no-typecheck');
    expect(b.code).toBe(1);
    expect(b.out.checks.d_4f435b65).toBe('failed');
  });

  it('answers usage errors with exit 2, and an unknown project with a hint', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'oodle-none-'));
    expect(await oodle(empty, 'status')).toMatchObject({ code: 1 });
    expect((await oodle(project(), 'answer')).code).toBe(2);
  });

  it('sync without a remote is a one-line no-op', async () => {
    expect((await oodle(project(), 'sync')).out.skipped).toMatch(/No remote/);
  });
});
