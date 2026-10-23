import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { systemMap } from '../src/explain.ts';
import { diffRuns } from '../src/diff.ts';
import { diffMarkdown, systemMarkdown } from '../src/report.ts';
import { runProject } from '../src/runner.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

const INVENTORY = `version: 0
actors:
  - { id: shopper, statement: Someone buying from the store }
capabilities:
  - id: checkout.create
    statement: A shopper can pay for a cart and get one receipt
    actor: shopper
    intent: buy-without-surprises
    surfaces: [POST /checkout]
  - id: health.read
    statement: 'TODO: who can do what through GET /health?'
    surfaces: [GET /health]
    status: proposed
unknowns:
  - { id: unserved.customers-track-orders, question: Is order tracking planned?, answer: Planned for Q1 }
`;

function project(inventory = INVENTORY): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-explain-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  if (inventory) writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), inventory);
  return dir;
}

test('system map: each capability with its outcomes, the rungs it has, and the next one', async () => {
  const map = systemMap(await runProject(project()));
  const checkout = map.capabilities.find((c) => c.id === 'checkout.create')!;
  // Outcomes that never name a capability still belong to the one whose surfaces reach their trigger.
  assert.deepEqual(checkout.outcomes.map((o) => o.state), ['holds', 'holds', 'holds', 'holds']);
  assert.deepEqual(checkout.calls, ['email.sent', 'payment.capture']);
  assert.deepEqual(checkout.rungs, { capability: true, outcome: true, intent: true, experience: false });
  assert.match(checkout.next!, /add an experience/);
  const health = map.capabilities.find((c) => c.id === 'health.read')!;
  assert.deepEqual(health.behaviors, ['ops.health']);
  assert.match(health.next!, /say what it does/);
  assert.deepEqual(map.intents.find((i) => i.id === 'buy-without-surprises')!.outcomes, []);
  assert.deepEqual(map.summary, { capabilities: 2, confirmed: 1, protected: 1, inferred_only: 0, routes: 2, claimed: 2 });
  const md = systemMarkdown(map);
  assert.match(md, /\| `checkout\.create` \| A shopper can pay for a cart and get one receipt \| shopper \| `POST \/checkout` \| 4 hold \|/);
  assert.match(md, /## No intent yet/);
});

test('system map: without capabilities, outcomes sit under their intents and routes are unclaimed', async () => {
  const map = systemMap(await runProject(project('')));
  assert.equal(map.capabilities.length, 0);
  assert.equal(map.intents.find((i) => i.id === 'buy-without-surprises')!.outcomes.length, 4);
  assert.deepEqual(map.unclaimed.sort(), ['GET /health', 'POST /checkout']);
});

test('outcome diff: says which capabilities a change reaches and what it does to the inventory, never blocking for it', async () => {
  const base = project();
  const head = project(INVENTORY.replace("    statement: 'TODO: who can do what through GET /health?'\n    surfaces: [GET /health]\n    status: proposed", '    statement: An operator can see that the service answers\n    surfaces: [GET /health]'));
  const app = join(head, 'src', 'app.ts');
  writeFileSync(app, readFileSync(app, 'utf8').replace('body: { ok: true }', "body: { ok: true, version: '2' }"));
  const report = diffRuns(await runProject(base), await runProject(head));
  assert.equal(report.blocking, 0);
  assert.deepEqual(report.capabilities.touched, [{ id: 'health.read', statement: 'An operator can see that the service answers', by: ['ops.health (changed)'] }]);
  assert.deepEqual(report.capabilities.changes.map((c) => `${c.id} ${c.status}`), ['health.read confirmed']);
  assert.match(report.capabilities.changes[0].details[0], /^statement: TODO/);
  const md = diffMarkdown(report);
  assert.match(md, /### Capabilities \(report only\)/);
  assert.match(md, /- `health\.read` reached by `ops\.health` \(changed\)/);
});

test('cli: explain prints the map, narrows with --only, and writes markdown', () => {
  const dir = project();
  const run = (args: string[]) => spawnSync(process.execPath, [join(ROOT, 'bin', 'oodle.js'), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const text = run(['explain', dir]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /checkout\.create\s+A shopper can pay/);
  assert.match(text.stdout, /nothing serves this yet \(Planned for Q1\)/);
  const one = run(['explain', dir, '--only', 'checkout.*']);
  assert.match(one.stdout, /outcome\s+checkout\.payment-confirmed\s+holds/);
  assert.doesNotMatch(one.stdout, /health\.read/);
  assert.match(run(['explain', dir, '--format', 'md']).stdout, /^# What the system does/);
  const none = run(['explain', dir, '--only', 'nope', '--json']);
  assert.equal(none.status, 2);
  assert.equal(JSON.parse(none.stdout).error.code, 'no-match');
});
