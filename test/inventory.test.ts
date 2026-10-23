import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { routesFrom, templateOf, readEvidence } from '../src/evidence.ts';
import { reaches } from '../src/runner.ts';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'oodle.js');
const SITE = 'https://shop.example.test';

const oodle = (args: string[], cwd?: string) => {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, NO_COLOR: '1', OODLE_QUIET: '1' } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
};
const json = (r: { stdout: string }) => JSON.parse(r.stdout);

const entry = (page: string, n: number, method: string, url: string) => ({ pageref: page, startedDateTime: `2026-10-20T10:00:0${n}Z`, request: { method, url } });
const HAR = { log: { entries: [
  entry('p1', 0, 'GET', `${SITE}/api/v2/orders/ord_1`), entry('p1', 1, 'POST', `${SITE}/api/v2/orders/ord_1/refund`), entry('p1', 2, 'GET', `${SITE}/main.css`), entry('p1', 3, 'GET', 'https://cdn.other.test/lib'),
  entry('p2', 4, 'GET', `${SITE}/api/v2/orders/ord_22`), entry('p2', 5, 'POST', `${SITE}/api/v2/orders/ord_22/refund`),
] } };

/** An empty folder, as for a service Oodle can't run, made an inventory project. */
function inventoryProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-inventory-')), 'svc');
  assert.equal(oodle(['init', '--inventory', dir]).code, 0);
  return dir;
}

function har(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'oodle-har-')), 'session.har');
  writeFileSync(path, JSON.stringify(HAR));
  return path;
}

test('templateOf: record ids become parameters; names and versions stay', () => {
  assert.equal(templateOf('/api/v2/orders/ord_1/refund'), '/api/v2/orders/:id/refund');
  assert.equal(templateOf('/users/42'), '/users/:id');
  assert.equal(templateOf('/files/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'), '/files/:id');
  assert.equal(templateOf('/health'), '/health');
});

test('routesFrom: traffic on the service\'s own host, templated, without assets', () => {
  const routes = routesFrom([readEvidence(har())], reaches, /\.(css|js)$/);
  assert.deepEqual(routes, ['GET /api/v2/orders/:id', 'POST /api/v2/orders/:id/refund']);
});

test('inventory project: no app, so it explains from evidence and never runs anything', () => {
  const dir = inventoryProject();
  assert.doesNotMatch(readFileSync(join(dir, 'oodlc', 'config.yaml'), 'utf8'), /^app:/m);
  assert.equal(json(oodle(['discover', dir, '--json'])).error.code, 'evidence');
  const found = json(oodle(['discover', dir, '--from', har(), '--json']));
  assert.deepEqual(found.capabilities.map((c: any) => c.id), ['orders.read', 'orders.refund']);
  assert.deepEqual(found.experiences.map((x: any) => x.steps), [['orders.read', 'orders.refund']]);
  assert.equal(json(oodle(['explain', dir, '--json'])).capabilities.length, 2);
  const run = oodle(['run', dir]);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Nothing runs here/);
  assert.equal(json(oodle(['propose', '--routes', dir, '--json'])).error.code, 'no-app');
  assert.equal(json(oodle(['mutate', dir, '--json'])).error.code, 'no-app');
  assert.match(oodle(['doctor', dir]).stdout, /no app, so this project explains a system/);
});

test('inventory project: a promise with nothing to run it is a lint error, so it blocks', () => {
  const dir = inventoryProject();
  writeFileSync(join(dir, 'oodlc', 'outcomes.yaml'), 'version: 0\nintents: [{ id: refunds, statement: Customers get their money back }]\noutcomes:\n  - { id: refund.works, intent: refunds, statement: A refund returns the money, boundary: customer, trigger: { http: POST /refund }, expect: { status: 200 } }\n');
  const lint = json(oodle(['lint', dir, '--json']));
  assert.ok(lint.errors.some((e: string) => /1 outcome declared, but nothing runs it: there is no app/.test(e)));
  assert.equal(oodle(['run', dir]).code, 1);
});

test('inventory project: check reports what a change does to the inventory, and blocks on nothing', () => {
  const dir = inventoryProject();
  oodle(['discover', dir, '--from', har()]);
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('add', '.');
  g('commit', '-qm', 'base');
  const file = join(dir, 'oodlc', 'proposed.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/(  - id: orders\.refund\n    statement: )[^\n]*\n/, '$1A customer can get their money back for an order\n'));
  const check = oodle(['check', dir, '--json']);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  const report = json(check);
  assert.equal(report.blocking, 0);
  assert.deepEqual(report.capabilities.changes.map((c: any) => `${c.id} ${c.status}`), ['orders.refund changed']);
});
