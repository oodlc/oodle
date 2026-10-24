import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type OodleEnv, oodle, rt } from '../src/index.ts';

function app() {
  const a = new Hono<OodleEnv>();
  a.use(oodle());
  a.get('/x', (c) => c.json({ id: rt(c).id('walk'), id2: rt(c).id('walk'), other: rt(c).id('rating'), now: rt(c).now().toISOString(), r: rt(c).random() }));
  return a;
}
const sim = { OODLE_MODE: 'sim' as const };

describe('the runtime', () => {
  it('in the simulation, counts ids per kind and reads the harness clock', async () => {
    const a = app();
    await a.request('/__oodle/reset', { method: 'POST', body: JSON.stringify({ seed: 7, clock: '2026-11-02T08:00:00Z' }) }, sim);
    const first = await (await a.request('/x', {}, sim)).json();
    expect(first).toMatchObject({ id: 'walk_1', id2: 'walk_2', other: 'rating_1', now: '2026-11-02T08:00:00.000Z' });
    await a.request('/__oodle/reset', { method: 'POST', body: JSON.stringify({ seed: 7, clock: '2026-11-02T08:00:00Z' }) }, sim);
    expect(await (await a.request('/x', {}, sim)).json()).toEqual(first);
  });

  it('in production, has no simulation routes and real ids', async () => {
    const a = app();
    for (const path of ['/__oodle/login?user=ada', '/__oodle/reset', '/__oodle/outbox'])
      expect((await a.request(path, { method: 'POST' }, { OODLE_MODE: 'prod' })).status).toBe(404);
    expect((await a.request('/__oodle/login?user=ada', {}, {})).status).toBe(404);
    const body = (await (await a.request('/x', {}, { OODLE_MODE: 'prod' })).json()) as { id: string };
    expect(body.id).toMatch(/^walk_[0-9a-f]{16}$/);
  });
});
