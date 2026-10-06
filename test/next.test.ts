import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'next-app');

/**
 * A copy of the fixture whose `next` is the given package from Oodle's node_modules (next is 16, next15 is 15).
 * Its node_modules links every package of Oodle's, and runs use --preserve-symlinks, so Next's requires of
 * `next/...` find this `next` and not the other version, as in a real install.
 */
function fixtureOn(pkg: string): string {
  const dir = mkdtempSync(join(tmpdir(), `oodle-${pkg}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  mkdirSync(join(dir, 'node_modules'));
  for (const name of readdirSync(join(ROOT, 'node_modules'))) {
    if (name === 'next' || name === 'next15' || name.startsWith('.')) continue;
    symlinkSync(join(ROOT, 'node_modules', name), join(dir, 'node_modules', name));
  }
  symlinkSync(join(ROOT, 'node_modules', pkg), join(dir, 'node_modules', 'next'));
  const app = join(dir, 'oodle.app.ts');
  writeFileSync(app, readFileSync(app, 'utf8').replace('@oodlc/oodle/next', join(ROOT, 'src', 'next.ts')));
  return dir;
}

function node(args: string[], cwd: string) {
  const env = { ...process.env };
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'OODLE_FORMAT', 'GITHUB_ACTIONS', 'CI', 'NODE_ENV', 'GREETING']) delete env[k];
  const res = spawnSync(process.execPath, ['--preserve-symlinks', ...args], { cwd, encoding: 'utf8', env });
  let out;
  try { out = JSON.parse(res.stdout); } catch { out = null; }
  return { code: res.status, out, stderr: res.stderr };
}

for (const [pkg, label] of [['next', 'Next 16'], ['next15', 'Next 15']] as const) {
  test(`${label}: route handlers run behind the middleware, with Next's own cookies(), redirect() and notFound()`, { skip: !existsSync(join(ROOT, 'node_modules', pkg)) && `${pkg} isn't installed` }, () => {
    const dir = fixtureOn(pkg);
    const { code, out, stderr } = node([BIN, 'run', dir, '--json'], dir);
    assert.ok(out, stderr);
    const failing = out.observations.filter((o: any) => o.failures.length || o.error).map((o: any) => `${o.id}: ${o.error ?? o.failures.join('; ')}`);
    assert.deepEqual(failing, []);
    assert.equal(code, 0, stderr);

    const probe = node(['--import', 'tsx', join(FIXTURE, '..', 'next-probe.ts'), dir, 'GET /api/orders', 'GET /api/redirect', 'GET /api/boom'], dir);
    assert.ok(probe.out, probe.stderr);
    const { routes, responses, effects } = probe.out;
    // Headers the middleware set on NextResponse.next() reach the caller; its own x-middleware-* headers don't.
    assert.equal(responses['GET /api/orders'].headers['x-seen-by-middleware'], '/api/orders');
    assert.deepEqual(Object.keys(responses['GET /api/orders'].headers).filter((h) => h.startsWith('x-middleware-')), []);
    assert.match(responses['GET /api/redirect'].headers.location, /\/api\/hello$/);
    // The error behind a 500 is kept, as internal behavior that never affects an outcome.
    assert.deepEqual(effects, [{ kind: 'internal.next.error', payload: { where: '/api/boom', message: 'the database is on fire' } }]);
    // Every route file is listed, [id] and [...path] as parameters; route groups and private folders aren't paths.
    for (const r of ['GET /api/orders', 'POST /api/orders', 'GET /api/orders/:id', 'DELETE /api/orders/:id', 'GET /api/hello', 'GET /api/files/:path', 'GET /api/badge']) assert.ok(routes.includes(r), `${r} in ${routes.join(', ')}`);
    assert.ok(!routes.some((r: string) => /\(|_lib/.test(r)), routes.join(', '));
  });
}
