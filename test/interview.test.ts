import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { applyAnswers, idFor, interviewPrompt, questions, runInterview } from '../src/interview.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

/** The checkout example with what `oodle discover` would propose, plus a comment that must survive edits. */
const DISCOVERED = `version: 0
# Drafted by discover.
capabilities:
  - id: checkout.create
    statement: 'TODO: who can do what through POST /checkout?'
    intent: buy-without-surprises
    surfaces: [POST /checkout]
    evidence: ["POST /checkout: calls email.sent, payment.capture"]
    status: proposed
  - id: health.read
    statement: 'TODO: who can do what through GET /health?'
    surfaces: [GET /health]
    status: proposed
unknowns:
  - { id: why.health.read, question: Who uses GET /health?, about: [health.read] }
  - { id: unserved.customers-track-orders, question: Is order tracking planned?, about: [customers-track-orders] }
`;

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-interview-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  writeFileSync(join(dir, 'oodlc', 'proposed.yaml'), DISCOVERED);
  return dir;
}
const catalogOf = (dir: string) => loadCatalog(dir, loadConfig(dir));
const file = (dir: string) => readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');

/** Answers given in order; null once they run out, as at the end of input. */
const scripted = (answers: string[]) => {
  const asked: string[] = [];
  return { asked, io: { ask: async (p: string) => (asked.push(p), answers.length ? answers.shift()! : null), say: () => {} } };
};

test('questions: capability by capability, the one with more evidence first, then the open questions', () => {
  const q = questions(catalogOf(project()));
  assert.deepEqual(q.map((x) => `${x.kind} ${x.target}`), [
    'statement checkout.create', 'confirm checkout.create',
    'statement health.read', 'why health.read', 'confirm health.read',
    // why.health.read is health.read's own `why`, so it isn't asked twice.
    'open unserved.customers-track-orders',
  ]);
  assert.ok(q[0].evidence.includes('POST /checkout: calls email.sent, payment.capture'));
});

test('answers from a person: written in place, comments kept, new actors and intents are theirs, the why question goes', () => {
  const dir = project();
  const r = applyAnswers(dir, [
    { kind: 'capability', id: 'health.read', statement: 'An operator can see that the service answers', actor: { id: '', statement: 'Whoever keeps the store running' }, intent: { id: '', statement: 'Keep the store up for everyone' } },
    { kind: 'unknown', id: 'unserved.customers-track-orders', answer: 'Planned for Q1' },
  ], { byPerson: true });
  assert.deepEqual(r.changed, ['capability health.read: statement, new actor whoever-keeps-the-store-running, new intent keep-the-store-up', 'question unserved.customers-track-orders: answered']);
  const text = file(dir);
  assert.match(text, /# Drafted by discover\./);
  const doc = parse(text);
  const health = doc.capabilities.find((c: any) => c.id === 'health.read');
  assert.equal(health.statement, 'An operator can see that the service answers');
  assert.equal(health.intent, 'keep-the-store-up');
  assert.equal(doc.intents[0].status, undefined);
  assert.deepEqual(doc.unknowns.map((u: any) => u.id), ['unserved.customers-track-orders']);
  assert.equal(doc.unknowns[0].answer, 'Planned for Q1');
  // An answered question is no longer open.
  assert.deepEqual(questions(catalogOf(dir)).filter((q) => q.kind === 'open'), []);
});

test('answers from an agent: never confirm, never touch a confirmed capability, and what they add is a proposal', () => {
  const dir = project();
  assert.throws(() => applyAnswers(dir, [{ kind: 'capability', id: 'checkout.create', confirm: true }], { byPerson: false }), /a person's call/);
  applyAnswers(dir, [{ kind: 'capability', id: 'checkout.create', statement: 'A shopper can pay for a cart', actor: { id: 'shopper', statement: 'Someone buying' } }], { byPerson: false });
  assert.equal(parse(file(dir)).actors[0].status, 'proposed');
  applyAnswers(dir, [{ kind: 'capability', id: 'checkout.create', confirm: true }], { byPerson: true });
  assert.throws(() => applyAnswers(dir, [{ kind: 'capability', id: 'checkout.create', statement: 'Something else' }], { byPerson: false }), /only a person changes it/);
});

test('answers that would break the catalog change nothing', () => {
  const dir = project();
  const before = file(dir);
  assert.throws(() => applyAnswers(dir, [{ kind: 'capability', id: 'health.read', statement: 'An operator can check it', actor: 'nobody' }], { byPerson: true }), (err: any) => /unknown actor "nobody"/.test(err.problems.join('\n')));
  assert.equal(file(dir), before);
});

test('runInterview: asks, writes as it goes, offers to confirm, and keeps what was said when the person stops', async () => {
  const dir = project();
  const { io, asked } = scripted(['A shopper can pay for a cart and get one receipt', 'shopper', 'Someone buying from the store', 'y', 'q']);
  const summary = await runInterview(dir, io, { canConfirm: true });
  assert.deepEqual(summary.changed, ['capability checkout.create: statement, new actor shopper', 'capability checkout.create: confirmed']);
  assert.match(asked[3], /Confirm "A shopper can pay for a cart and get one receipt"\?/);
  const checkout = parse(file(dir)).capabilities.find((c: any) => c.id === 'checkout.create');
  assert.equal(checkout.status, undefined);
  // What "shopper" means is now asked too: the person's own statement used the word.
  assert.equal(summary.remaining, 5);
  assert.ok(questions(catalogOf(dir)).some((q) => q.kind === 'define' && q.target === 'shopper'));
});

test('runInterview: a vague statement is pushed back once; without someone there, nothing is confirmed', async () => {
  const dir = project();
  const { io, asked } = scripted(['Handles checkout', 'A shopper can pay for a cart', '']);
  await runInterview(dir, io, { canConfirm: false });
  assert.equal(asked.filter((p) => /Confirm/.test(p)).length, 0);
  const checkout = parse(file(dir)).capabilities.find((c: any) => c.id === 'checkout.create');
  assert.equal(checkout.statement, 'A shopper can pay for a cart');
  assert.equal(checkout.status, 'proposed');
});

test('idFor: short, readable, unique', () => {
  assert.equal(idFor('Keep the store up for everyone', new Set()), 'keep-the-store-up');
  assert.equal(idFor('Shopper', new Set(['shopper'])), 'shopper-2');
});

test('interview prompt: the rules, the intents, and each question with its evidence', () => {
  const text = interviewPrompt(project());
  assert.match(text, /Never guess who a capability is for/);
  assert.match(text, /`buy-without-surprises`: Customers can buy without surprises/);
  assert.match(text, /\[statement\] `checkout\.create`[\s\S]*POST \/checkout: calls email\.sent/);
});

test('cli: lists the questions without a terminal, and writes answers piped in with --ask', () => {
  const dir = project();
  const run = (args: string[], input = '') => spawnSync(process.execPath, [join(ROOT, 'bin', 'oodle.js'), ...args], { encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1' } });
  const listed = run(['interview', dir]);
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /say\s+checkout\.create/);
  assert.match(listed.stdout, /nothing written/);
  assert.equal(JSON.parse(run(['interview', dir, '--json']).stdout).questions.length, 6);
  const answered = run(['interview', dir, '--ask'], 'A shopper can pay for a cart\nshopper\n\n');
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(answered.stdout, /capability checkout\.create: statement, new actor shopper/);
  assert.equal(parse(file(dir)).capabilities[0].status, 'proposed');
});
