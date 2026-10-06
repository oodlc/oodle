// Runs a project's oodle.app.ts in process and prints what --json leaves out: routes, response headers, effects.
// Used by test/next.test.ts: node --import tsx test/fixtures/next-probe.ts <dir> "GET /path" ...
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [dir, ...requests] = process.argv.slice(2);
const mod = createRequire(join(dir, 'package.json'))(join(dir, 'oodle.app.ts'));
const createApp = mod.default?.default ?? mod.default ?? mod;
const effects: unknown[] = [];
const app = createApp({
  effects: { emit: (kind: string, payload: unknown) => void effects.push({ kind, payload }), call: async () => ({ id: 'ch_ok' }) },
  state: {},
  id: (p: string) => `${p}_1`,
  now: () => '2026-01-01T00:00:00.000Z',
});
const responses: Record<string, unknown> = {};
for (const r of requests) {
  const [method, path] = r.split(' ');
  const res = await app.handle({ method, path });
  responses[r] = { status: res.status, headers: res.headers };
}
console.log(JSON.stringify({ routes: app.routes.map((r: { method: string; path: string }) => `${r.method} ${r.path}`), responses, effects }));
