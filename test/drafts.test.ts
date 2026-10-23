// Outcomes drafted from confirmed capabilities: oodle propose --routes and --capabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { proposeCapabilities, proposeRoutes } from '../src/propose.ts';
import { lint } from '../src/lint.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

/** examples/checkout with GET /orders/:id, which nothing describes, and an inventory. */
function project(inventory: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-drafts-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  const app = join(dir, 'src', 'app.ts');
  writeFileSync(app, readFileSync(app, 'utf8').replace(
    "{ method: 'POST', path: '/checkout', handler: checkout },",
    "{ method: 'POST', path: '/checkout', handler: checkout },\n    { method: 'GET', path: '/orders/:id', handler: async (c, _r, p) => { const o = (c.state.orders ?? []).find((x: any) => x.id === p.id); return o ? { status: 200, body: o } : { status: 404, body: { error: 'order_not_found' } }; } },",
  ));
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), inventory);
  return dir;
}

const proposed = (dir: string) => parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'));
const CONFIRMED = 'version: 0\ncapabilities:\n  - { id: orders.read, statement: A shopper can look up one of their orders., intent: customers-track-orders, surfaces: [GET /orders/:id] }\n';

test('propose --routes: under a confirmed capability, the statement is drafted from its words and what the probe saw, with no TODO', async () => {
  const dir = project(CONFIRMED);
  await proposeRoutes(dir);
  const [outcome] = proposed(dir).outcomes;
  assert.equal(outcome.statement, 'A shopper can look up one of their orders. Asked for a made-up id, GET /orders/:id answers 404 (order_not_found), with no outside call or write.');
  assert.doesNotMatch(outcome.statement, /TODO/);
  assert.equal(outcome.capability, 'orders.read');
  assert.equal(outcome.status, 'proposed');
  assert.deepEqual(outcome.expect, { status: 404, body: { error: 'order_not_found' } });
});

test('propose --routes: under a capability nobody confirmed, the statement stays a TODO that names it', async () => {
  const dir = project(CONFIRMED.replace(' }\n', ', status: proposed }\n'));
  await proposeRoutes(dir);
  assert.equal(proposed(dir).outcomes[0].statement, 'TODO: say what a caller can count on. Observed: GET /orders/:id answered 404. Confirm the capability orders.read first, and the draft starts from what it says.');
  // Confirmed but still saying nothing is no better.
  const vague = project(CONFIRMED.replace('A shopper can look up one of their orders.', "'TODO: who can do what through GET /orders/:id?'"));
  await proposeRoutes(vague);
  assert.match(proposed(vague).outcomes[0].statement, /^TODO: .*Say what the capability orders\.read does first/);
});

test('propose --routes: running it twice adds nothing new', async () => {
  const dir = project(CONFIRMED);
  assert.equal((await proposeRoutes(dir)).added.length, 1);
  const before = readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');
  assert.deepEqual((await proposeRoutes(dir)).added, []);
  assert.equal(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'), before);
});

test('propose --capabilities: one outcome per surface of each confirmed capability with none, and nothing for the rest', async () => {
  const dir = project(`version: 0
capabilities:
  - { id: orders.read, statement: A shopper can look up one of their orders, surfaces: [GET /orders/:id] }
  - { id: health.read, statement: An operator can see that the service answers, surfaces: [GET /health] }
  - { id: buying, statement: A shopper can pay for a cart, surfaces: [POST /checkout] }
  - { id: carts.read, statement: A shopper can see their cart, status: proposed, surfaces: [GET /carts/:id] }
  - { id: refunds.create, statement: A shopper can get their money back, surfaces: [POST /refunds] }
`);
  const result = await proposeCapabilities(dir);
  // buying has outcomes already; carts.read isn't confirmed; nothing serves POST /refunds.
  assert.deepEqual(result.added.map((a) => a.id), ['get-orders-id', 'get-health']);
  assert.deepEqual(result.skipped, ['refunds.create: no route serves POST /refunds']);
  const outcomes = proposed(dir).outcomes;
  // GET /health is already run by the ops.health behavior: the draft reuses its trigger and what it returned.
  const health = outcomes.find((o: any) => o.id === 'get-health');
  assert.equal(health.capability, 'health.read');
  assert.equal(health.statement, 'An operator can see that the service answers. GET /health answers 200, with no outside call or write.');
  assert.deepEqual(health.expect, { status: 200, body: { ok: true } });
  assert.ok(outcomes.every((o: any) => o.status === 'proposed' && !/TODO/.test(o.statement)));
  assert.deepEqual(lint(loadCatalog(dir, loadConfig(dir))).errors, []);
  // Its proposals now protect those capabilities, so again adds nothing.
  assert.deepEqual((await proposeCapabilities(dir)).added, []);
});

test('propose --capabilities: the CLI and the MCP propose tool return the same document', () => {
  const dir = project(CONFIRMED);
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', OODLE_QUIET: '1' };
  for (const k of ['OODLE_FORMAT', 'GITHUB_ACTIONS', 'CI', 'NODE_TEST_CONTEXT']) delete env[k];
  const cli = spawnSync(process.execPath, [BIN, 'propose', '--capabilities', dir, '--json'], { encoding: 'utf8', env, timeout: 300_000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).added, [{ section: 'outcomes', id: 'get-orders-id' }]);

  const fresh = project(CONFIRMED);
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose', arguments: { draft: 'capabilities' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose', arguments: { draft: 'everything' } } },
  ];
  const mcp = spawnSync(process.execPath, [BIN, 'mcp', fresh], { encoding: 'utf8', env, input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', timeout: 300_000 });
  const replies = new Map(mcp.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  const viaMcp = JSON.parse(replies.get(2).result.content[0].text);
  const viaCli = JSON.parse(cli.stdout);
  assert.deepEqual(viaMcp, viaCli);
  assert.equal(replies.get(3).result.isError, true);
  const both = spawnSync(process.execPath, [BIN, 'propose', '--routes', '--capabilities', dir, '--json'], { encoding: 'utf8', env });
  assert.equal(both.status, 2);
});
