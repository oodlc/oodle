// Stubs and request bodies from traffic, scrubbed: docs/decisions/0015.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { Scrubber, scrubBody } from '../src/scrub.ts';
import { readEvidence } from '../src/evidence.ts';
import { proposeRoutes } from '../src/propose.ts';
import { effectRules, proposeStubs } from '../src/traffic.ts';
import { runProject } from '../src/runner.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const SITE = 'https://shop.example.test';

const oodle = (args: string[], input?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', OODLE_QUIET: '1' };
  for (const k of ['OODLE_FORMAT', 'GITHUB_ACTIONS', 'CI', 'NODE_TEST_CONTEXT']) delete env[k];
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input, env, timeout: 300_000 });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** examples/express-orders in a temp dir, with a route nothing describes that takes a body. */
function service(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-traffic-')), 'orders');
  cpSync(join(ROOT, 'examples', 'express-orders'), dir, { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const app = join(dir, 'oodle.app.ts');
  writeFileSync(app, readFileSync(app, 'utf8').replace("'@oodlc/oodle/adapter'", `'${join(ROOT, 'src', 'adapter.ts')}'`));
  const server = join(dir, 'src', 'server.ts');
  writeFileSync(server, readFileSync(server, 'utf8').replace("app.post('/orders/:id/refund'",
    "app.post('/carts', (req, res) => {\n  const { items } = req.body ?? {};\n  if (!Array.isArray(items) || !items.length) return void res.status(400).json({ error: 'empty_cart' });\n  res.status(201).json({ id: 'cart_1', items: items.length });\n});\n\napp.post('/orders/:id/refund'"));
  return dir;
}

function file(name: string, content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'oodle-traffic-ev-')), name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

/** Every fake secret the fixture carries. None of them may come out the other side. */
const SECRETS = {
  bearer: 'sk_live_51HxQ2bLkdIwHu7ixVnSzzQ', cookie: 'sessionid=8f2a9c1e5b7d4e8a9c217d4e5f6a8b90', setCookie: 'csrftoken=Zq81mN0pQ7rS4tU2vW9xY',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGFAZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJlLXZhbHVl', email: 'ada.lovelace@example.com',
  card: '4111 1111 1111 1111', cardDigits: '4111111111111111', phone: '+1 (415) 555-0123', name: 'Ada Lovelace', first: 'ermengarde',
  street: '12 Analytical Engine Way', ip: '203.0.113.77', note: 'Leave it with Charles Babbage next door', password: 'hunter2',
  customer: 'cus_Q8x2LmN4pR7tV9wZ', apiKey: 'AKIAIOSFODNN7EXAMPLE', query: 'reset=Zm9vYmFyYmF6cXV4',
};

const at = (s: number) => `2026-10-20T10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const header = (name: string, value: string) => ({ name, value });
const json = (v: unknown) => ({ mimeType: 'application/json', text: JSON.stringify(v) });
const charge = (n: number, status: number, ms: number, body: unknown) => ({
  startedDateTime: at(n), time: ms,
  request: { method: 'POST', url: `https://api.stripe.com/v1/charges?${SECRETS.query}`, headers: [header('Authorization', `Bearer ${SECRETS.bearer}`), header('Cookie', SECRETS.cookie)],
    postData: { mimeType: 'application/x-www-form-urlencoded', text: `amount=1800&currency=usd&customer=${SECRETS.customer}&receipt_email=${encodeURIComponent(SECRETS.email)}` } },
  response: { status, headers: [header('Set-Cookie', SECRETS.setCookie)], content: json(body) },
});
/** What the service sent Stripe and SendGrid, recorded at its egress, and what its callers sent it. */
const EGRESS = { log: { entries: [
  charge(0, 200, 120, { id: 'ch_3PqR8sT1uV2wX3yZ', object: 'charge', status: 'succeeded', amount: 1800, currency: 'usd', customer: SECRETS.customer, billing_details: { name: SECRETS.name, email: SECRETS.email, phone: SECRETS.phone, address: { line1: SECRETS.street } }, payment_method_details: { card: { number: SECRETS.cardDigits, last4: '1111', brand: 'visa' } }, metadata: { note: SECRETS.note, client_ip: SECRETS.ip } }),
  charge(60, 200, 180, { id: 'ch_9AbC8dE7fG6hI5jK', object: 'charge', status: 'succeeded', amount: 900, currency: 'usd' }),
  charge(120, 402, 300, { error: { type: 'card_error', code: 'card_declined', message: `Your card ${SECRETS.card} was declined, ${SECRETS.name}` } }),
  charge(180, 200, 240, { id: 'ch_1MnO2pQ3rS4tU5vW', object: 'charge', status: 'succeeded', amount: 450, currency: 'usd' }),
  { startedDateTime: at(200), time: 90, request: { method: 'POST', url: 'https://api.sendgrid.com/v3/mail/send', headers: [header('Authorization', `Bearer ${SECRETS.apiKey}`)], postData: json({ to: SECRETS.email, template: 'receipt' }) }, response: { status: 202, content: { mimeType: 'text/plain', text: '' } } },
  { startedDateTime: at(210), time: 40, request: { method: 'GET', url: `https://telemetry.other.test/collect/${SECRETS.jwt}` }, response: { status: 204 } },
  { startedDateTime: at(240), time: 30, request: { method: 'POST', url: `${SITE}/carts`, headers: [header('Cookie', SECRETS.cookie)],
    postData: json({ items: [{ sku: 'tee', qty: 2 }], email: SECRETS.email, first_name: SECRETS.first, password: SECRETS.password, card: SECRETS.card, gift_note: SECRETS.note }) }, response: { status: 201, content: json({ id: 'cart_1' }) } },
] } };

test('scrub: keeps keys, numbers and codes; replaces everything personal or secret with a placeholder, the same one each time', () => {
  const s = new Scrubber();
  const out = s.value({ status: 'succeeded', currency: 'usd', amount: 1800, paid: true, email: SECRETS.email, again: SECRETS.email, card: SECRETS.card, cardNumber: 4111111111111111, phone: SECRETS.phone, ip: SECRETS.ip, token: SECRETS.jwt, first_name: SECRETS.first, note: SECRETS.note, id: 'ch_3PqR8sT1uV2wX3yZ', [SECRETS.email]: 1 }) as any;
  assert.equal(out.status, 'succeeded');
  assert.equal(out.currency, 'usd');
  assert.equal(out.amount, 1800);
  assert.equal(out.email, 'person1@example.test');
  assert.equal(out.again, 'person1@example.test');
  assert.match(out.card, /^4000000000000\d{3}$/);
  assert.notEqual(out.cardNumber, 4111111111111111);
  assert.equal(out.phone, '+15550100001');
  assert.equal(out.ip, '192.0.2.1');
  assert.equal(out.token, 'token-1');
  assert.equal(out.first_name, 'text-1');
  assert.equal(out.note, 'text-2');
  assert.equal(out.id, 'ch_placeholder2');
  assert.ok(!(SECRETS.email in out) && 'key-1' in out);
  // The same input always gives the same output.
  assert.deepEqual(new Scrubber().value({ a: SECRETS.note, b: SECRETS.email }), new Scrubber().value({ a: SECRETS.note, b: SECRETS.email }));
  // Bodies that aren't JSON or a form are dropped, not kept as text.
  assert.equal(scrubBody(new Scrubber(), `<p>${SECRETS.name}</p>`, 'text/html'), undefined);
});

test('propose --stubs: the answer seen most, its median latency, and each other status as a condition; defaults never touched, runs unchanged', async () => {
  const dir = service();
  const config = join(dir, 'oodlc', 'config.yaml');
  const before = readFileSync(config, 'utf8');
  const runBefore = await runProject(dir);
  const result = proposeStubs(dir, [file('egress.har', EGRESS)], await effectRules(dir));
  assert.deepEqual(result.stubs.map((s) => s.kind), ['payment.charge', 'email.sent']);
  const doc = parse(readFileSync(config, 'utf8'));
  const proposedCharge = doc.proposed.stubs['payment.charge'];
  assert.equal(proposedCharge.latency_ms, 180);
  assert.equal(proposedCharge.result.status, 'succeeded');
  assert.equal(proposedCharge.result.amount, 1800);
  assert.equal(proposedCharge.result.billing_details.email, 'person1@example.test');
  assert.match(proposedCharge.evidence[0].text, /^seen 4 times in egress\.har \(4 min, 7 requests, hosts: .*\): 200 ×3 \(median 180 ms\), 402 ×1 \(median 300 ms\)$/);
  assert.equal(proposedCharge.evidence[0].grade, 'observed');
  assert.deepEqual(doc.proposed.stubs['email.sent'].result, {});
  // The declined card is a condition, inert until an outcome lists it.
  assert.deepEqual(result.added, [{ section: 'conditions', id: 'observed.payment-charge-402' }]);
  const declined = parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8')).conditions[0];
  assert.equal(declined.given.stubs['payment.charge'].result.$status, 402);
  assert.equal(declined.given.stubs['payment.charge'].result.error.code, 'card_declined');
  assert.deepEqual(result.unmatched, ['shop.example.test', 'telemetry.other.test']);
  // Comments and defaults are as they were; only proposed was added.
  const after = readFileSync(config, 'utf8');
  assert.ok(after.startsWith(before.trimEnd()), 'the config only gains a proposed section');
  assert.deepEqual(parse(after).defaults, parse(before).defaults);
  // No run reads a proposal.
  const runAfter = await runProject(dir);
  assert.deepEqual(runAfter.observations.map((o) => [o.id, o.status, o.body]), runBefore.observations.map((o) => [o.id, o.status, o.body]));
  // Again adds nothing.
  const again = proposeStubs(dir, [file('egress.har', EGRESS)], await effectRules(dir));
  assert.deepEqual([again.stubs, again.added, again.waiting], [[], [], ['payment.charge', 'email.sent']]);
});

test('propose --stubs from OTLP client spans: status and median latency, and a result that says it is a placeholder', async () => {
  const dir = service();
  const attr = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { intValue: v } : { stringValue: v } });
  const span = (start: number, ms: number, status: number) => ({ kind: 3, startTimeUnixNano: String(BigInt(start) * 1_000_000_000n), endTimeUnixNano: String(BigInt(start) * 1_000_000_000n + BigInt(ms) * 1_000_000n),
    attributes: [attr('http.request.method', 'POST'), attr('url.full', `https://api.stripe.com/v1/refunds?${SECRETS.query}`), attr('http.response.status_code', status)] });
  const traces = file('traces.json', { resourceSpans: [{ scopeSpans: [{ spans: [span(1760954400, 100, 200), span(1760954460, 300, 200), span(1760954520, 200, 200)] }] }] });
  const result = proposeStubs(dir, [traces], await effectRules(dir));
  const refund = result.stubs.find((s) => s.kind === 'payment.refund')!.stub;
  assert.deepEqual(refund.result, {});
  assert.equal(refund.latency_ms, 200);
  assert.match(refund.evidence[0].text, /200 ×3 \(median 200 ms\); no response body to read, so the result is a placeholder$/);
});

test('propose --routes --from: a route a caller sent a body to is probed with it, scrubbed', async () => {
  const dir = service();
  const result = await proposeRoutes(dir, [file('session.har', EGRESS)]);
  assert.deepEqual(result.added.map((a) => a.id), ['post-carts']);
  const outcome = parse(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8')).outcomes[0];
  assert.deepEqual(outcome.trigger.given.body.items, [{ sku: 'tee', qty: 2 }]);
  assert.equal(outcome.trigger.given.body.email, 'person1@example.test');
  assert.equal(outcome.expect.status, 201);
  assert.match(outcome.statement, /^TODO: say what a caller can count on\. Observed: POST \/carts answered 201/);
  assert.equal(outcome.status, 'proposed');
});

test('the hook asks before an edit accepts a proposed stub into defaults', () => {
  const before = 'app: oodle.app.ts\ndefaults:\n  given:\n    stubs:\n      payment.charge: { result: {} }\nproposed:\n  stubs:\n    payment.charge: { result: { status: succeeded }, latency_ms: 180 }\n';
  const accepted = 'app: oodle.app.ts\ndefaults:\n  given:\n    stubs:\n      payment.charge: { result: { status: succeeded }, latency_ms: 180 }\n';
  const dir = service();
  const config = join(dir, 'oodlc', 'config.yaml');
  writeFileSync(config, before);
  const ask = oodle(['hook', 'pre-tool-use'], JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: config, content: accepted } }));
  const out = JSON.parse(ask.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /accepts the proposed stub payment\.charge/);
});

/** Every file under a directory, as text, skipping node_modules. */
function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? everyFile(path) : [readFileSync(path, 'utf8')];
  });
}

test('privacy: no secret from a capture reaches any file Oodle writes, the terminal, the JSON or an MCP reply', () => {
  const dir = service();
  const har = file('egress.har', EGRESS);
  const said: string[] = [];
  const run = (args: string[]) => {
    const r = oodle(args);
    said.push(r.stdout, r.stderr);
    return r;
  };
  for (const format of [[], ['--json']]) {
    run(['discover', dir, '--from', har, ...format]);
    run(['propose', '--stubs', '--from', har, dir, ...format]);
    run(['propose', '--routes', '--from', har, dir, ...format]);
    run(['explain', dir, ...format]);
    run(['interview', dir, '--json']);
    run(['doctor', dir, ...format]);
  }
  const fresh = service();
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'discover', arguments: { from: [har] } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose', arguments: { draft: 'stubs', from: [har] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose', arguments: { draft: 'routes', from: [har] } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'catalog', arguments: {} } },
  ];
  const mcp = oodle(['mcp', fresh], msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  said.push(mcp.stdout, mcp.stderr);
  const replies = mcp.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(replies.filter((m) => m.id >= 2).every((m) => m.result && !m.result.isError), mcp.stdout.slice(0, 2000));
  const everything = [...said, ...everyFile(dir), ...everyFile(fresh), JSON.stringify(readEvidence(har))].join('\n');
  // Sanity: the run did write proposals from this capture.
  assert.match(everything, /payment\.charge/);
  assert.match(everything, /person1@example\.test/);
  for (const [what, secret] of Object.entries(SECRETS)) assert.ok(!everything.includes(secret), `${what} leaked: ${secret}`);
});
