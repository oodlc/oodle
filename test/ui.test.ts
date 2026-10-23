import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approve, serveUi } from '../src/ui.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** The checkout example with a discovered capability, a proposed outcome and an open question. */
function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-ui-')), 'checkout');
  cpSync(join(ROOT, 'examples', 'checkout'), dir, { recursive: true });
  writeFileSync(join(dir, 'oodlc', 'proposed.yaml'), `version: 0
# Drafted by discover.
capabilities:
  - id: health.read
    statement: 'TODO: who can do what through GET /health?'
    surfaces: [GET /health]
    status: proposed
outcomes:
  - id: ops.health-answers
    intent: buy-without-surprises
    statement: The health check answers 200
    boundary: customer
    trigger: { http: GET /health }
    expect: { status: 200 }
    status: proposed
unknowns:
  - { id: unserved.customers-track-orders, question: Is order tracking planned?, about: [customers-track-orders] }
`);
  return dir;
}
const catalogOf = (dir: string) => loadCatalog(dir, loadConfig(dir));

async function server(dir: string, byPerson: boolean) {
  const ui = await serveUi(dir, { port: 0, byPerson, version: 'test', token: 'secret-token' });
  const base = `http://127.0.0.1:${ui.port}`;
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-oodle-token': 'secret-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, doc: await r.json() as any }));
  return { ui, base, call };
}

test('ui: serves the page to anyone, and the catalog only with the token, the right Host and no foreign Origin', async () => {
  const { ui, base, call } = await server(project(), true);
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Oodle Studio/);
    assert.equal((await call('/api/state', undefined, { 'x-oodle-token': 'wrong' })).status, 401);
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await call('/api/state', undefined, { origin: 'http://evil.example' })).status, 403);
    // node's fetch won't send a forged Host, so ask node:http directly.
    const { request } = await import('node:http');
    const status = await new Promise<number>((done) => request({ host: '127.0.0.1', port: ui.port, path: '/api/state', headers: { host: 'rebound.example', 'x-oodle-token': 'secret-token' } }, (r) => (r.resume(), done(r.statusCode!))).end());
    assert.equal(status, 421);
    assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=secret-token$/);
  } finally {
    await ui.close();
  }
});

test('ui: state is the catalog, its lint, its questions and what waits for a person', async () => {
  const { ui, call } = await server(project(), true);
  try {
    const { status, doc } = await call('/api/state');
    assert.equal(status, 200);
    assert.equal(doc.ok, true);
    assert.equal(doc.byPerson, true);
    assert.deepEqual(doc.proposals.map((p: any) => `${p.section} ${p.id}`), ['capabilities health.read', 'outcomes ops.health-answers']);
    assert.ok(doc.questions.some((q: any) => q.target === 'unserved.customers-track-orders'));
    assert.match(doc.yaml['outcomes:ops.health-answers'], /trigger:\n {2}http: GET \/health/);
    assert.equal(doc.run, null);
  } finally {
    await ui.close();
  }
});

test('ui: a broken file is shown, not a crash', async () => {
  const dir = project();
  writeFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'version: 0\noutcomes: [ {id: x\n');
  const { ui, call } = await server(dir, true);
  try {
    const { status, doc } = await call('/api/state');
    assert.equal(status, 200);
    assert.equal(doc.ok, false);
    assert.ok(doc.error.message);
  } finally {
    await ui.close();
  }
});

test('ui: a person approves a proposed outcome; the status line goes and the comments stay', async () => {
  const dir = project();
  const { ui, call } = await server(dir, true);
  try {
    const { status, doc } = await call('/api/approve', { section: 'outcomes', id: 'ops.health-answers', statement: 'The health check answers 200 to anyone' });
    assert.equal(status, 200, JSON.stringify(doc));
    assert.deepEqual(doc.changed, ['outcome ops.health-answers: statement, approved']);
    const text = readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');
    assert.match(text, /# Drafted by discover\./);
    const o = catalogOf(dir).outcomes.find((x) => x.id === 'ops.health-answers')!;
    assert.equal(o.status, undefined);
    assert.equal(o.statement, 'The health check answers 200 to anyone');
  } finally {
    await ui.close();
  }
});

test('ui: started without a terminal, it approves nothing and answers with an agent\'s rights', async () => {
  const dir = project();
  const before = readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');
  const { ui, call } = await server(dir, false);
  try {
    const refused = await call('/api/approve', { section: 'outcomes', id: 'ops.health-answers' });
    assert.equal(refused.status, 403);
    assert.equal(refused.doc.error.code, 'approved');
    const confirm = await call('/api/answer', { answer: { kind: 'capability', id: 'health.read', confirm: true } });
    assert.equal(confirm.status, 403);
    assert.equal(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'), before);
    // A new intent an agent names arrives as a proposal.
    const answered = await call('/api/answer', { answer: { kind: 'capability', id: 'health.read', statement: 'An operator can check the store is up', intent: { id: '', statement: 'Operators know the store is up' } } });
    assert.equal(answered.status, 200, JSON.stringify(answered.doc));
    const c = catalogOf(dir);
    assert.equal(c.capabilities.find((x) => x.id === 'health.read')!.status, 'proposed');
    assert.equal(c.intents.find((x) => x.id === c.capabilities.find((y) => y.id === 'health.read')!.intent)!.status, 'proposed');
  } finally {
    await ui.close();
  }
});

test('approve: a capability that still says nothing stays proposed', () => {
  const dir = project();
  const before = readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');
  assert.throws(() => approve(dir, 'capabilities', 'health.read', { byPerson: true }), (e: any) => e.code === 'answer');
  assert.equal(readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8'), before);
  approve(dir, 'capabilities', 'health.read', { byPerson: true, statement: 'An operator can check the store is up' });
  assert.equal(catalogOf(dir).capabilities.find((x) => x.id === 'health.read')!.status, undefined);
});

test('ui: runs the catalog in a child process and keeps the result', { timeout: 120_000 }, async () => {
  const { ui, call } = await server(project(), true);
  try {
    const { status, doc } = await call('/api/run', {});
    assert.equal(status, 200, JSON.stringify(doc).slice(0, 400));
    assert.equal(doc.run.summary.broken, 0);
    assert.ok(doc.map.capabilities.some((c: any) => c.id === 'health.read'));
    const state = await call('/api/state');
    assert.equal(state.doc.run.at, doc.at);
  } finally {
    await ui.close();
  }
});
