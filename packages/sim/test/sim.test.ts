import { describe, expect, it } from 'vitest';
import { loadBuild, runScenarios } from '../src/index.ts';
import { DOGWALK_A, variant } from './fixtures/variants.ts';
import { FIRST_BOOKING, FIXTURES } from './scenarios.ts';

describe('the simulation', () => {
  it('runs a journey on a hand-written app through its driver', async () => {
    const [result] = await runScenarios(await loadBuild(DOGWALK_A), [FIRST_BOOKING]);
    const [booked, accepted, cancelled] = result?.observations ?? [];
    expect(booked).toMatchObject({ as: 'owner:ada', status: 303, mail: [] });
    expect(booked?.view.headings).toEqual(['Walk with Sam']);
    expect(booked?.view.text).toContain('Requested, $20.00');
    expect(accepted).toMatchObject({ as: 'owner:ada', status: 303 });
    expect(accepted?.view.text).toContain('Accepted, $20.00');
    expect(accepted?.mail).toEqual([{ to: 'ada@example.com', subject: 'Sam accepted your walk', text: 'Sam will walk your dog on Tue 3 Nov, 09:00.' }]);
    expect(cancelled?.view.text).toContain('Cancelled, no charge');
    expect(result?.escapes).toEqual([]);
  });

  it('gives byte-identical observations when the same scenario runs twice', async () => {
    const build = await loadBuild(DOGWALK_A);
    const first = JSON.stringify(await runScenarios(build, [FIRST_BOOKING, FIRST_BOOKING], { parallel: 1 }));
    const second = JSON.stringify(await runScenarios(build, [FIRST_BOOKING, FIRST_BOOKING], { parallel: 2 }));
    expect(second).toBe(first);
    const [a, b] = JSON.parse(first);
    expect(a.observations).toEqual(b.observations);
  });

  it('refuses what the app refuses, and says so', async () => {
    const [result] = await runScenarios(await loadBuild(DOGWALK_A), [
      {
        id: 'explore/permissions/cancel-other',
        fixtures: FIXTURES,
        steps: [
          { as: 'owner:ada', do: 'owner.book_walk', input: { walker: 'walker:sam', starts_at: '2026-11-03T09:00:00Z', minutes: 30 } },
          { as: 'owner:bea', do: 'owner.cancel_walk', input: { walk: '$walk_1' } },
          { as: 'owner:ada', do: 'owner.do_a_dance' },
        ],
      },
    ]);
    expect(result?.observations[1]).toMatchObject({ status: 403, blocked: true });
    expect(result?.observations[1]?.view.text).toContain("You can't cancel this walk.");
    expect(result?.observations[2]?.error).toBe('the driver has no action "owner.do_a_dance"');
  });

  it('captures outbound requests made through the runtime, and reports any that went around it', async () => {
    const dir = variant([
      {
        why: 'an outbound call through the runtime and one around it',
        file: 'src/index.tsx',
        from: '  return c.redirect(`/walks/${id}`, 303);',
        to: "  await rt(c).fetch('https://api.payments.test/holds', { method: 'POST' });\n  await fetch('https://tracker.test/booked');\n  return c.redirect(`/walks/${id}`, 303);",
      },
    ]);
    const [result] = await runScenarios(await loadBuild(dir), [FIRST_BOOKING]);
    expect(result?.observations[0]?.outbound).toEqual([{ host: 'api.payments.test', method: 'POST' }]);
    expect(result?.escapes).toEqual([{ url: 'https://tracker.test/booked', method: 'GET' }]);
  });
});
