import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { singular, undefinedWords, vocabulary } from '../src/terms.ts';
import { applyAnswers, questions, runInterview } from '../src/interview.ts';
import { systemMap } from '../src/explain.ts';
import { runProject } from '../src/runner.ts';
import { lint } from '../src/lint.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const EXAMPLE = resolve(import.meta.dirname, '..', 'examples', 'checkout');
const INVENTORY = `version: 0
actors:
  - { id: shopper, statement: Someone buying from the store }
capabilities:
  - { id: orders.read, statement: A shopper can see an order they placed, intent: customers-track-orders, surfaces: [GET /orders/:id] }
  - { id: checkout.create, statement: A shopper can pay for a cart and get one receipt, intent: buy-without-surprises, surfaces: [POST /checkout] }
`;

function project(extra = ''): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-terms-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), INVENTORY + extra);
  return dir;
}
const catalogOf = (dir: string) => loadCatalog(dir, loadConfig(dir));

test('singular: close enough for matching words', () => {
  assert.deepEqual(['orders', 'categories', 'addresses', 'boxes', 'status', 'analysis', 'pass', 'order'].map(singular), ['order', 'category', 'address', 'box', 'status', 'analysis', 'pass', 'order']);
});

test('vocabulary: the resources the system acts on and its actors, not its plumbing', () => {
  assert.deepEqual(vocabulary(catalogOf(project())), ['checkout', 'order', 'shopper']);
});

test('lint: once a catalog defines a term, the system\'s other words used in statements need one too', () => {
  const dir = project();
  // No terms yet: nothing to say, so existing catalogs stay quiet.
  assert.ok(!lint(catalogOf(dir)).warnings.some((w) => w.startsWith('terms:')));
  writeFileSync(join(dir, 'oodlc', 'terms.yaml'), 'version: 0\nterms:\n  - { id: shopper, statement: Anyone with a customer_id who has a cart, aka: [customer, buyer] }\n');
  const warnings = lint(catalogOf(dir)).warnings.filter((w) => w.startsWith('terms:'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^terms: "order" is used in 5 statements \(intent customers-track-orders, capability orders\.read, .*\) and no term says what it means/);
  // "customer" in an intent is the shopper, by its aka.
  assert.ok(!undefinedWords(catalogOf(dir)).some((u) => u.word === 'customer'));
});

test('lint: one word, one meaning', () => {
  const dir = project();
  writeFileSync(join(dir, 'oodlc', 'terms.yaml'), 'version: 0\nterms:\n  - { id: shopper, statement: A person buying, aka: [customer] }\n  - { id: customer, statement: A company with an account }\n');
  assert.ok(lint(catalogOf(dir)).errors.some((e) => /"customer" is also defined by the term shopper/.test(e)));
});

test('interview: asks what each undefined word means and writes it to oodlc/terms.yaml', async () => {
  const dir = project();
  const define = questions(catalogOf(dir)).filter((q) => q.kind === 'define').map((q) => q.target);
  // "checkout" names a route, but no statement uses the word, so there is nothing to ask yet.
  assert.deepEqual(define, ['order', 'shopper']);
  const ask = ['A cart that was paid for, with its items, total and charge', 'purchase', 'Anyone with a customer_id who has a cart', 'customer, buyer'];
  // The capabilities already say what they do and why, so the words are all that's asked.
  const summary = await runInterview(dir, { ask: async () => (ask.length ? ask.shift()! : null), say: () => {} }, { canConfirm: false });
  assert.deepEqual(summary.changed, ['term order: defined', 'term shopper: defined']);
  const terms = parse(readFileSync(join(dir, 'oodlc', 'terms.yaml'), 'utf8')).terms;
  assert.deepEqual(terms.find((t: any) => t.id === 'shopper'), { id: 'shopper', statement: 'Anyone with a customer_id who has a cart', aka: ['customer', 'buyer'] });
  assert.equal(terms.find((t: any) => t.id === 'order').aka[0], 'purchase');
});

test('answers from an agent: a proposed term, never confirmed; a broken answer creates no file', () => {
  const dir = project();
  applyAnswers(dir, [{ kind: 'term', id: 'order', statement: 'A paid cart' }], { byPerson: false });
  assert.equal(parse(readFileSync(join(dir, 'oodlc', 'terms.yaml'), 'utf8')).terms[0].status, 'proposed');
  assert.throws(() => applyAnswers(dir, [{ kind: 'term', id: 'order', confirm: true }], { byPerson: false }), /a person's call/);
  const fresh = project();
  assert.throws(() => applyAnswers(fresh, [{ kind: 'term', id: 'order', statement: 'A paid cart', aka: ['shopper'] }, { kind: 'term', id: 'shopper', statement: 'Someone buying' }], { byPerson: true }));
  assert.equal(existsSync(join(fresh, 'oodlc', 'terms.yaml')), false);
});

test('explain: a glossary, and the words still undefined', async () => {
  const dir = project();
  writeFileSync(join(dir, 'oodlc', 'terms.yaml'), 'version: 0\nterms:\n  - { id: order, statement: A cart that was paid for }\n');
  const map = systemMap(await runProject(dir));
  assert.deepEqual(map.terms, [{ id: 'order', statement: 'A cart that was paid for', aka: [], proposed: false }]);
  assert.deepEqual(map.undefined_words, ['shopper']);
});
