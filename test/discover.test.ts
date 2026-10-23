import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { capabilityId, discover, inventoryFrom } from '../src/discover.ts';
import { proposeRoutes } from '../src/propose.ts';
import { runProject } from '../src/runner.ts';
import { lint } from '../src/lint.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const EXAMPLES = resolve(import.meta.dirname, '..', 'examples');

function copy(example: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-discover-')), example);
  cpSync(join(EXAMPLES, example), dir, { recursive: true });
  return dir;
}

const proposed = (dir: string) => parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'));

test('capabilityId: the resource a route acts on, and what it does to it', () => {
  assert.equal(capabilityId('POST /checkout'), 'checkout.create');
  assert.equal(capabilityId('GET /orders'), 'orders.read');
  assert.equal(capabilityId('GET /orders/:id'), 'orders.read');
  assert.equal(capabilityId('POST /orders/:id/refund'), 'orders.refund');
  assert.equal(capabilityId('DELETE /api/v2/carts/:cartId/items/:itemId'), 'carts.items.delete');
  assert.equal(capabilityId('GET /users/:id/orders'), 'users.orders');
  assert.equal(capabilityId('PATCH /users/[id]'), 'users.update');
  assert.equal(capabilityId('GET /'), 'root.read');
});

test('discover: routes become proposed capabilities with their evidence, an intent when the outcomes agree, and questions for the rest', async () => {
  const dir = copy('checkout');
  const result = await discover(dir);
  assert.deepEqual(result.added.map((a) => `${a.section}:${a.id}`).sort(), ['capabilities:checkout.create', 'capabilities:health.read', 'unknowns:unserved.customers-track-orders', 'unknowns:why.health.read']);
  const doc = proposed(dir);
  const checkout = doc.capabilities.find((c: any) => c.id === 'checkout.create');
  assert.equal(checkout.status, 'proposed');
  assert.equal(checkout.intent, 'buy-without-surprises');
  assert.deepEqual(checkout.surfaces, ['POST /checkout']);
  assert.ok(checkout.evidence.includes('POST /checkout: calls email.sent, payment.capture'));
  assert.ok(checkout.evidence.some((e: string) => e.startsWith('POST /checkout: described by outcomes checkout.payment-confirmed,')));
  assert.equal(doc.capabilities.find((c: any) => c.id === 'health.read').intent, undefined);
  assert.deepEqual(result.links.find((l) => l.id === 'ops.health'), { id: 'ops.health', kind: 'behavior', capability: 'health.read' });
  // Proposals never block, and the TODO statements ask a person for the words.
  const l = lint(loadCatalog(dir, loadConfig(dir)));
  assert.deepEqual(l.errors, []);
  assert.ok(l.warnings.some((w) => w.includes('checkout.create: statement is still a TODO')));
});

test('discover: running it again adds nothing', async () => {
  const dir = copy('checkout');
  await discover(dir);
  const before = readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');
  const again = await discover(dir);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.known.sort(), ['GET /health', 'POST /checkout']);
  assert.equal(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'), before);
});

test('discover: a route an existing capability lists is left alone', async () => {
  const dir = copy('checkout');
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), 'version: 0\ncapabilities:\n  - { id: buying, statement: A shopper can pay for a cart, surfaces: [POST /checkout] }\n');
  const inv = inventoryFrom(await runProject(dir));
  assert.deepEqual(inv.capabilities.map((c) => c.id), ['health.read']);
  assert.deepEqual(inv.known, ['POST /checkout']);
  assert.ok(inv.links.some((x) => x.id === 'checkout.payment-confirmed' && x.capability === 'buying'));
});

test('propose --routes: a route a capability lists gets that capability and its intent, not a made-up intent', async () => {
  const dir = copy('checkout');
  const app = join(dir, 'src', 'app.ts');
  writeFileSync(app, readFileSync(app, 'utf8').replace(
    "{ method: 'POST', path: '/checkout', handler: checkout },",
    "{ method: 'POST', path: '/checkout', handler: checkout },\n    { method: 'GET', path: '/orders/:id', handler: async (c, _r, p) => { const o = (c.state.orders ?? []).find((x: any) => x.id === p.id); return o ? { status: 200, body: o } : { status: 404, body: { error: 'order_not_found' } }; } },",
  ));
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), 'version: 0\ncapabilities:\n  - { id: orders.read, statement: A customer can see an order they placed, intent: customers-track-orders, surfaces: [GET /orders/:id] }\n');
  const result = await proposeRoutes(dir);
  assert.deepEqual(result.added, [{ section: 'outcomes', id: 'get-orders-id' }]);
  const outcome = proposed(dir).outcomes[0];
  assert.equal(outcome.capability, 'orders.read');
  assert.equal(outcome.intent, 'customers-track-orders');
  assert.match(outcome.statement, /about "A customer can see an order they placed"/);
  assert.equal(proposed(dir).intents, undefined);
});
