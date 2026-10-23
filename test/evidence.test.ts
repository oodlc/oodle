import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { readEvidence } from '../src/evidence.ts';
import { discover } from '../src/discover.ts';
import { applyAnswers, questions } from '../src/interview.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const EXAMPLE = resolve(import.meta.dirname, '..', 'examples', 'checkout');
const SITE = 'https://shop.example.test';

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-evidence-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

function file(name: string, content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'oodle-ev-')), name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const OPENAPI = `openapi: 3.0.0
info: { title: Store, version: '1' }
servers: [{ url: 'https://shop.example.test/' }]
paths:
  /checkout:
    post: { summary: Pay for the items in a cart, operationId: checkout, tags: [orders] }
  /orders/{id}:
    get: { summary: Look up an order }
`;

const entry = (page: string, n: number, method: string, url: string) => ({ pageref: page, startedDateTime: `2026-10-20T10:00:0${n}Z`, request: { method, url } });
const HAR = { log: { entries: [
  entry('p1', 0, 'GET', `${SITE}/app.js`), entry('p1', 1, 'GET', `${SITE}/health`), entry('p1', 2, 'POST', `${SITE}/checkout`), entry('p1', 3, 'GET', 'https://analytics.other.test/collect'),
  entry('p2', 4, 'GET', `${SITE}/health`), entry('p2', 5, 'POST', `${SITE}/checkout`), entry('p2', 6, 'GET', `${SITE}/orders/ord_1`),
  entry('p3', 7, 'GET', `${SITE}/health`),
] } };

const span = (kind: number, method: string, key: string, path: string) => ({ kind, attributes: [{ key: 'http.request.method', value: { stringValue: method } }, { key, value: { stringValue: path } }] });
const OTLP = { resourceSpans: [{ scopeSpans: [{ spans: [span(2, 'POST', 'http.route', '/checkout'), span(2, 'GET', 'url.path', '/health'), span(3, 'POST', 'url.path', '/v1/charges')] }] }] };

test('readEvidence: OpenAPI operations with their words, HAR requests by page, OTLP server spans', () => {
  const spec = readEvidence(file('openapi.yaml', OPENAPI));
  assert.equal(spec.kind, 'openapi');
  assert.deepEqual(spec.seen, [
    { method: 'POST', path: '/checkout', summary: 'Pay for the items in a cart', operationId: 'checkout', tags: ['orders'], host: 'shop.example.test' },
    { method: 'GET', path: '/orders/:id', summary: 'Look up an order', host: 'shop.example.test' },
  ]);
  const har = readEvidence(file('session.har', HAR));
  assert.equal(har.kind, 'har');
  assert.equal(har.sequences.length, 3);
  assert.equal(har.seen.find((s) => s.path === '/health')!.count, 3);
  const otlp = readEvidence(file('traces.json', OTLP));
  // The client span is this service calling someone else, so it is left out.
  assert.deepEqual(otlp.seen.map((s) => `${s.method} ${s.path} ${s.count}`), ['POST /checkout 1', 'GET /health 1']);
  assert.throws(() => readEvidence(file('other.json', { hello: 1 })), /not an OpenAPI spec, a HAR capture or an OTLP trace export/);
});

test('discover --from: the spec\'s words, real use first, a repeated journey, and where evidence and code disagree', async () => {
  const dir = project();
  const result = await discover(dir, [file('openapi.yaml', OPENAPI), file('session.har', HAR), file('traces.json', OTLP)]);
  // GET /health has the most requests, so it comes first.
  assert.deepEqual(result.capabilities.map((c) => c.id), ['health.read', 'checkout.create']);
  const checkout = result.capabilities.find((c) => c.id === 'checkout.create')!;
  assert.match(checkout.statement, /The spec says "Pay for the items in a cart"/);
  assert.ok(checkout.evidence!.includes('POST /checkout: openapi.yaml says "Pay for the items in a cart" (checkout), tagged orders'));
  assert.ok(checkout.evidence!.includes('POST /checkout: 2 requests in session.har'));
  assert.ok(checkout.evidence!.includes('POST /checkout: 1 request in traces.json'));
  assert.deepEqual(result.experiences.map((x) => [x.id, x.steps, x.evidence]), [['journey.health-read-then-checkout-create', ['health.read', 'checkout.create'], ['seen 2 times in session.har']]]);
  const ids = result.unknowns.map((u) => u.id);
  assert.ok(ids.includes('spec-only.openapi-yaml'));
  const unrouted = result.unknowns.find((u) => u.id === 'unrouted.session-har')!;
  // Assets and other sites' requests are not this service's business.
  assert.match(unrouted.question, /GET \/orders\/ord_1 \(1\)\./);
  assert.doesNotMatch(unrouted.question, /app\.js|collect/);
  assert.deepEqual(parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8')).experiences[0].status, 'proposed');
});

test('discover --from: a capability no captured request reached gets a question', async () => {
  const dir = project();
  const result = await discover(dir, [file('session.har', { log: { entries: [entry('p1', 0, 'GET', `${SITE}/health`)] } })]);
  const unused = result.unknowns.find((u) => u.id === 'unused.checkout.create')!;
  assert.match(unused.question, /No request in session\.har reached POST \/checkout/);
});

test('interview: an experience asks what people are trying to do and what would feel broken, and writes both', async () => {
  const dir = project();
  await discover(dir, [file('session.har', HAR)]);
  const q = questions(loadCatalog(dir, loadConfig(dir))).filter((x) => x.about === 'experience').map((x) => x.kind);
  assert.deepEqual(q, ['statement', 'broken', 'why', 'confirm']);
  applyAnswers(dir, [{ kind: 'experience', id: 'journey.health-read-then-checkout-create', statement: 'A shopper checks the store is up, then pays', feels_broken_when: ['charged twice', ' no receipt '] }], { byPerson: false });
  const x = parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8')).experiences[0];
  assert.equal(x.statement, 'A shopper checks the store is up, then pays');
  assert.deepEqual(x.feels_broken_when, ['charged twice', 'no receipt']);
  assert.throws(() => applyAnswers(dir, [{ kind: 'experience', id: x.id, confirm: true }], { byPerson: false }), /a person's call/);
});
