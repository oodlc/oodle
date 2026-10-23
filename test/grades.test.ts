// Evidence grades, and coverage is not absence: docs/decisions/0014.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { discover } from '../src/discover.ts';
import { readEvidence } from '../src/evidence.ts';
import { systemMap } from '../src/explain.ts';
import { propose } from '../src/propose.ts';
import { questions } from '../src/interview.ts';
import { catalogConcerns } from '../src/hooks.ts';
import { lint } from '../src/lint.ts';
import { runProject } from '../src/runner.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const EXAMPLE = join(ROOT, 'examples', 'checkout');
const SITE = 'https://shop.example.test';

const oodle = (args: string[], input?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', OODLE_QUIET: '1' };
  for (const k of ['OODLE_FORMAT', 'GITHUB_ACTIONS', 'CI', 'NODE_TEST_CONTEXT']) delete env[k];
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input, env, timeout: 300_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
};

function checkout(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-grades-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

/** An empty folder made an inventory project: a service Oodle can't run (0011). */
function inventoryProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-grades-inv-')), 'svc');
  assert.equal(oodle(['init', '--inventory', dir]).code, 0);
  return dir;
}

function file(name: string, content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'oodle-grades-ev-')), name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const catalogOf = (dir: string) => loadCatalog(dir, loadConfig(dir));
const proposed = (dir: string) => parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'));

/** A 40-minute capture of the shop, with a CDN and an analytics host in it too. */
const at = (min: number) => `2026-10-20T10:${String(min).padStart(2, '0')}:00.000Z`;
const req = (min: number, method: string, url: string) => ({ pageref: 'p1', startedDateTime: at(min), request: { method, url } });
const CAPTURE = { log: { entries: [
  req(0, 'GET', `${SITE}/orders/ord_1`), req(5, 'GET', 'https://cdn.other.test/app.js'), req(10, 'POST', `${SITE}/checkout`),
  req(20, 'GET', `${SITE}/orders/ord_2`), req(30, 'GET', 'https://analytics.other.test/collect'), req(40, 'POST', `${SITE}/checkout`),
] } };
const SCOPE = '1 HAR capture, session.har (40 min, 6 requests, hosts: shop.example.test, analytics.other.test, cdn.other.test)';

const SPEC = `openapi: 3.0.0
info: { title: Shop, version: '1' }
servers: [{ url: 'https://shop.example.test/' }]
paths:
  /checkout:
    post: { summary: Pay for the items in a cart }
  /orders/{id}:
    get: { summary: Look up an order }
  /refunds:
    post: { summary: Refund an order, operationId: refund }
`;

test('readEvidence: each file records its scope: kind, file, first and last request, request count, hosts', () => {
  assert.deepEqual(readEvidence(file('session.har', CAPTURE)).scope, {
    kind: 'har', file: 'session.har', first: at(0), last: at(40), requests: 6, hosts: ['shop.example.test', 'analytics.other.test', 'cdn.other.test'],
  });
  const span = (start: string, host: string) => ({ kind: 2, startTimeUnixNano: start, attributes: [{ key: 'http.request.method', value: { stringValue: 'GET' } }, { key: 'http.route', value: { stringValue: '/health' } }, { key: 'server.address', value: { stringValue: host } }] });
  const traces = readEvidence(file('traces.json', { resourceSpans: [{ scopeSpans: [{ spans: [span('1760954400000000000', 'api.shop.test'), span('1760958000000000000', 'api.shop.test')] }] }] }));
  assert.deepEqual(traces.scope, { kind: 'otlp', file: 'traces.json', first: '2025-10-20T10:00:00.000Z', last: '2025-10-20T11:00:00.000Z', requests: 2, hosts: ['api.shop.test'] });
  assert.deepEqual(readEvidence(file('openapi.yaml', SPEC)).scope, { kind: 'openapi', file: 'openapi.yaml', requests: 3, hosts: ['shop.example.test'] });
});

test('an agent can\'t write observed evidence: propose grades everything it is given inferred, and answer refuses evidence', () => {
  const dir = checkout();
  propose(dir, { capabilities: [{ id: 'orders.read', statement: 'A shopper can see an order', surfaces: ['GET /orders/:id'], evidence: [{ text: 'GET /orders/:id: 9000 requests a day', grade: 'observed' }, 'GET /orders/:id: answered 200 when probed'] }] });
  assert.deepEqual(proposed(dir).capabilities[0].evidence, [
    { text: 'GET /orders/:id: 9000 requests a day', grade: 'inferred' },
    { text: 'GET /orders/:id: answered 200 when probed', grade: 'inferred' },
  ]);
  // The same over MCP, as an agent would call it, and through the answer tool.
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose', arguments: { yaml: 'experiences:\n  - id: browse\n    statement: A shopper looks around\n    evidence: [{ text: seen 40 times in prod, grade: observed }]\n' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'answer', arguments: { id: 'orders.read', statement: 'A shopper can see an order they placed', evidence: ['seen in the logs'], grade: 'observed' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'catalog', arguments: {} } },
  ];
  const r = oodle(['mcp', dir], msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const replies = new Map(r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(replies.get(2).result.isError, false);
  assert.equal(replies.get(3).result.isError, true);
  assert.match(JSON.parse(replies.get(3).result.content[0].text).error.message, /can't add evidence/);
  const catalog = JSON.parse(replies.get(4).result.content[0].text);
  const grades = [...catalog.capabilities, ...catalog.experiences].flatMap((x: any) => x.evidence.map((e: any) => e.grade));
  assert.deepEqual(grades, ['inferred', 'inferred', 'inferred']);
  // The rejected answer wrote nothing.
  assert.equal(catalogOf(dir).capabilities[0].statement, 'A shopper can see an order');
});

test('an agent can\'t hand-write observed evidence without the person: the hook asks', () => {
  const before = 'capabilities:\n  - id: orders.read\n    statement: A shopper can see an order\n    status: proposed\n    evidence:\n      - { text: "GET /orders/:id: served by the app", grade: observed }\n';
  assert.deepEqual(catalogConcerns(before, before.replace('status: proposed', 'status: proposed # still')), []);
  const upgraded = catalogConcerns(before, `${before}      - { text: "GET /orders/:id: 9000 requests a day", grade: observed }\n`);
  assert.deepEqual(upgraded, ['writes evidence graded observed for capability orders.read; only Oodle grades what it saw, through oodle discover']);
  assert.deepEqual(catalogConcerns(before, `${before}      - { text: "the team says it is popular", grade: inferred }\n`), []);
});

test('evidence with no grade loads as inferred, ranks nothing, and never makes a capability covered or protected', async () => {
  const dir = checkout();
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), `version: 0
capabilities:
  - id: orders.read
    statement: A shopper can see an order they placed
    surfaces: [GET /orders/:id]
    evidence:
      - "GET /orders/:id: answered 200 when probed"
      - "GET /orders/:id: protected by outcome checkout.payment-confirmed"
      - { text: "GET /orders/:id: 9000 requests a day" }
  - id: checkout.create
    statement: A shopper can pay for a cart
    surfaces: [POST /checkout]
    evidence:
      - { text: "POST /checkout: calls payment.capture", grade: observed }
`);
  const catalog = catalogOf(dir);
  assert.deepEqual(catalog.capabilities[0].evidence!.map((e) => e.grade), ['inferred', 'inferred', 'inferred']);
  // Three inferred lines rank below one observed line.
  assert.deepEqual([...new Set(questions(catalog).filter((q) => q.about === 'capability').map((q) => q.target))], ['checkout.create', 'orders.read']);
  // Lint counts outcomes, never what evidence says about them.
  assert.ok(lint(catalog).warnings.some((w) => w.endsWith('orders.read: capability has no outcomes yet. It is explained, not protected.')));
  const map = systemMap(await runProject(dir));
  const orders = map.capabilities.find((c) => c.id === 'orders.read')!;
  assert.equal(orders.inferred_only, true);
  assert.deepEqual(orders.outcomes, []);
  assert.equal(orders.rungs.outcome, false);
  assert.equal(map.capabilities.find((c) => c.id === 'checkout.create')!.inferred_only, false);
  assert.equal(map.summary.inferred_only, 1);
  assert.equal(map.summary.protected, 1);
});

test('explain shows the grade beside each piece of evidence and marks what is inferred only', () => {
  const dir = inventoryProject();
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), 'version: 0\ncapabilities:\n  - id: refunds.create\n    statement: A shopper can get their money back\n    surfaces: [POST /refunds]\n    evidence: ["openapi.yaml says Refund an order", { text: "POST /refunds: 3 requests in session.har", grade: observed }]\n  - id: orders.read\n    statement: A shopper can see an order\n    surfaces: [GET /orders/:id]\n    evidence: ["openapi.yaml says Look up an order"]\n');
  const text = oodle(['explain', dir, '--only', '*']).stdout;
  assert.match(text, /evidence\s+inferred\s+openapi\.yaml says Refund an order/);
  assert.match(text, /evidence\s+observed\s+POST \/refunds: 3 requests in session\.har/);
  assert.match(text, /orders\.read\s+A shopper can see an order\n\s+inferred only/);
  assert.doesNotMatch(text, /refunds\.create\s+A shopper can get their money back\n\s+inferred only/);
  const json = JSON.parse(oodle(['explain', dir, '--json']).stdout);
  assert.deepEqual(json.capabilities.map((c: any) => [c.id, c.inferred_only]), [['refunds.create', false], ['orders.read', true]]);
  assert.match(oodle(['explain', dir, '--format', 'md']).stdout, /\| `orders\.read` \(inferred only\) \|/);
});

test('an OpenAPI operation no request reached is inferred only and ranks last; one the app doesn\'t serve is only a question', async () => {
  const dir = inventoryProject();
  const result = await discover(dir, [file('openapi.yaml', SPEC), file('session.har', CAPTURE)]);
  // Traffic decides the order; the spec's refunds operation, which nobody was seen calling, comes last.
  assert.deepEqual(result.capabilities.map((c) => c.id), ['checkout.create', 'orders.read', 'refunds.create']);
  const refunds = result.capabilities.find((c) => c.id === 'refunds.create')!;
  assert.deepEqual(refunds.evidence!.map((e) => e.grade), ['inferred']);
  const map = systemMap(await runProject(dir));
  assert.deepEqual(map.capabilities.filter((c) => c.inferred_only).map((c) => c.id), ['refunds.create']);

  // With an app, an operation it doesn't serve never becomes a capability at all.
  const app = checkout();
  const withApp = await discover(app, [file('openapi.yaml', SPEC), file('session.har', CAPTURE)]);
  assert.ok(!withApp.capabilities.some((c) => c.surfaces!.includes('POST /refunds')));
  assert.match(withApp.unknowns.find((u) => u.id === 'spec-only.openapi-yaml')!.question, /POST \/refunds/);
});

test('a project with no app, from one HAR: every question about a capability the capture didn\'t reach names what it covered', async () => {
  const dir = inventoryProject();
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), 'version: 0\ncapabilities:\n  - { id: refunds.create, statement: A shopper can get their money back, surfaces: [POST /refunds] }\n  - { id: carts.read, statement: A shopper can see their cart, surfaces: [GET /carts/:id] }\n  - { id: buying, statement: A shopper can pay for a cart, surfaces: [POST /checkout] }\n');
  const result = await discover(dir, [file('session.har', CAPTURE)]);
  const unseen = result.unknowns.filter((u) => (u.about ?? []).some((id) => ['refunds.create', 'carts.read', 'buying'].includes(id)));
  assert.deepEqual(unseen.map((u) => u.id).sort(), ['unseen.carts.read', 'unseen.refunds.create']);
  for (const u of unseen) {
    assert.ok(u.question.includes(`Not seen in ${SCOPE}. That doesn't mean it's unused.`), u.question);
  }
  assert.deepEqual(result.evidence.map((e) => e.scope), [{ kind: 'har', file: 'session.har', first: at(0), last: at(40), requests: 6, hosts: ['shop.example.test', 'analytics.other.test', 'cdn.other.test'] }]);
  // Nothing anywhere says a route is dead or unused because a capture missed it.
  const said = [...result.unknowns.map((u) => u.question), ...result.capabilities.flatMap((c) => (c.evidence ?? []).map((e) => e.text))].join('\n');
  assert.doesNotMatch(said.replaceAll("That doesn't mean it's unused.", ''), /\b(dead|unused|no requests|nothing used)\b/i);
  // And the CLI says what it read in the same words.
  const cli = oodle(['discover', dir, '--from', file('session.har', CAPTURE)]);
  assert.match(cli.stdout, /read \S*session\.har: HAR, 40 min, 6 requests, hosts: shop\.example\.test, analytics\.other\.test, cdn\.other\.test/);
});

test('a capture\'s paths never reach a file, the terminal or the JSON as they were: ids, emails, tokens and query strings are scrubbed', async () => {
  const SECRETS = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGFAZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJl', 'ada.lovelace@example.com', 'ada%40example.com',
    'sk_live_51HxQ2bLkdIwHu7ixVnS', 'ord_8d1f2a', '4242424242424242', '+14155550123', 'Ada_Lovelace', 'reset_token=abc123', 'hunter2',
  ];
  const at2 = (n: number) => `2026-10-20T10:00:${String(n).padStart(2, '0')}Z`;
  const leak = { log: { entries: [
    { startedDateTime: at2(0), request: { method: 'GET', url: `${SITE}/password-reset/${SECRETS[0]}?email=${SECRETS[1]}`, headers: [{ name: 'Authorization', value: `Bearer ${SECRETS[3]}` }] } },
    { startedDateTime: at2(1), request: { method: 'GET', url: `${SITE}/users/${SECRETS[1]}/orders` } },
    { startedDateTime: at2(2), request: { method: 'GET', url: `${SITE}/users/${SECRETS[2]}/cards/${SECRETS[5]}` } },
    { startedDateTime: at2(3), request: { method: 'POST', url: `${SITE}/keys/${SECRETS[3]}?${SECRETS[8]}` } },
    { startedDateTime: at2(4), request: { method: 'GET', url: `${SITE}/orders/${SECRETS[4]}/contact/${SECRETS[6]}` } },
    { startedDateTime: at2(5), request: { method: 'GET', url: `${SITE}/people/${SECRETS[7]}?password=${SECRETS[9]}` } },
    { startedDateTime: at2(6), request: { method: 'GET', url: `${SITE}/assets/${SECRETS[1]}.png` } },
  ] } };
  const said: string[] = [];
  for (const dir of [checkout(), inventoryProject()]) {
    const har = file('leak.har', leak);
    said.push(JSON.stringify(await discover(dir, [har])));
    const cli = oodle(['discover', dir, '--from', har]);
    const json = oodle(['discover', dir, '--from', har, '--json']);
    said.push(cli.stdout, cli.stderr, json.stdout, json.stderr, oodle(['explain', dir, '--json']).stdout, oodle(['interview', dir, '--json']).stdout);
    for (const f of ['proposed.yaml', 'inventory.yaml', 'config.yaml']) {
      try {
        said.push(readFileSync(join(dir, 'oodlc', f), 'utf8'));
      } catch {
        // Not every project has every file.
      }
    }
  }
  const everything = said.join('\n');
  assert.match(everything, /\/password-reset\/:id/, 'the scrubbed path is what gets said');
  for (const s of SECRETS) assert.ok(!everything.includes(s), `${s} leaked`);
});
