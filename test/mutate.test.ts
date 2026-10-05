import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { failingTests, mutantsOf, scan } from '../src/mutate.ts';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'oodle.js');

test('scan: strings, comments, templates and regexes are not code', () => {
  const src = "const a = 'x < y'; // a < b\nconst r = /a+b/g; const t = `${a < 1} ok`; if (a < b) {}";
  const code = scan(src).code.map(([s, e]) => src.slice(s, e)).join('|');
  assert.doesNotMatch(code, /x < y|a < b\n|a\+b|ok/);
  assert.match(code, /if \(a < b\)/);
  assert.deepEqual(scan(src).strings.map(([s, e]) => src.slice(s, e)), ["'x < y'"]);
});

test('mutants: operators, literals and effects, but not imports, types or generics', () => {
  const src = [
    "import { x } from './x.ts';",
    'interface Item { qty: number; flag: true }',
    'export function f(ctx: Ctx, items: Array<Item>) {',
    '  if (items.length === 0) return { status: 400 };',
    "  ctx.effects.emit('email.sent', { to: 'a' });",
    '  return { status: 200, ok: !items[0]!.flag && a < b };',
    '}',
  ].join('\n');
  const ms = mutantsOf(src, 'f.ts').map((m) => `${m.line}:${m.operator}:${m.from}>${m.to}`);
  assert.ok(ms.includes('4:equality:===>!=='));
  assert.ok(ms.includes('4:literal:0>1'));
  assert.ok(ms.includes('4:literal:400>401'));
  assert.ok(ms.some((m) => m.startsWith('5:remove-effect:')));
  assert.ok(ms.includes("5:string:'email.sent'>''"));
  assert.ok(ms.includes('6:negation:!>'));
  assert.ok(ms.includes('6:logic:&&>||'));
  assert.ok(ms.includes('6:boundary:<><='));
  assert.ok(!ms.some((m) => m.startsWith('1:') || m.startsWith('2:')), ms.join('\n'));
  assert.ok(!ms.some((m) => m.startsWith('3:')), 'Array<Item> is a generic, not a comparison');
  assert.equal(ms.filter((m) => m.startsWith('6:negation')).length, 1, 'items[0]! is a non-null assertion');
});

test('failing test names are read from TAP and spec output', () => {
  assert.deepEqual(failingTests('ok 1 - fine\nnot ok 2 - bulk discount # time=1ms\n'), ['bulk discount']);
  assert.deepEqual(failingTests('✔ fine (0.1ms)\n✖ bulk discount (0.4ms)\n'), ['bulk discount']);
});

/** A plain-JS project (so it runs on every Node in CI) with one outcome and two unit tests. */
function pricingProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-mutate-')), 'pricing');
  mkdirSync(join(dir, 'oodlc'), { recursive: true });
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'oodlc', 'config.yaml'), 'app: src/app.mjs\n');
  writeFileSync(join(dir, 'oodlc', 'catalog.yaml'), [
    'version: 0',
    'intents: [{ id: fair-prices, statement: Customers pay what the price list says }]',
    'outcomes:',
    '  - id: price.single',
    '    intent: fair-prices',
    '    statement: One item costs its list price',
    '    boundary: customer',
    '    trigger: { http: POST /price, given: { body: { qty: 1 } } }',
    '    expect: { status: 200, body: { total: 500 } }',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'src', 'price.mjs'), 'export function total(qty) {\n  const gross = qty * 500;\n  return qty >= 10 ? gross - gross / 10 : gross;\n}\n');
  writeFileSync(join(dir, 'src', 'app.mjs'), "import { total } from './price.mjs';\nexport default function createApp() {\n  return { routes: [{ method: 'POST', path: '/price' }], async handle(req) { return { status: 200, body: { total: total(req.body.qty) } }; } };\n}\n");
  writeFileSync(join(dir, 'test', 'single.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from '../src/price.mjs';\ntest('single item price', () => assert.equal(total(1), 500));\n");
  writeFileSync(join(dir, 'test', 'bulk.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from '../src/price.mjs';\ntest('bulk discount', () => assert.equal(total(10), 4500));\n");
  return dir;
}

test('cli: oodle mutate scores the catalog and finds which unit tests it makes redundant', () => {
  const dir = pricingProject();
  const res = spawnSync(process.execPath, [BIN, 'mutate', dir, '--json', '--tests', 'node --test test/single.test.mjs test/bulk.test.mjs'], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const r = JSON.parse(res.stdout);
  assert.deepEqual(r.files, ['src/app.mjs', 'src/price.mjs']);
  // The outcome checks one item: it catches the price bugs, and misses the bulk discount ones.
  assert.ok(r.mutants.some((m: any) => m.file === 'src/price.mjs' && m.from === '500' && m.status === 'killed' && m.killed_by.includes('price.single')));
  assert.ok(r.mutants.some((m: any) => m.from === '>=' && m.status === 'survived'));
  assert.ok(r.score > 0 && r.score < 100);
  assert.deepEqual(r.tests.redundant, ['single item price']);
  assert.deepEqual(r.tests.no_kills, []);
  assert.ok(r.tests.killers.find((k: any) => k.id === 'bulk discount').beyond_catalog > 0);
  assert.ok(r.tests.catalog_misses.length > 0);

  const gated = spawnSync(process.execPath, [BIN, 'mutate', dir, '--json', '--min-score', '100'], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(gated.status, 1);
  assert.equal(JSON.parse(gated.stdout).ok, false);
});

test('cli: oodle mutate refuses a catalog that is not green first', () => {
  const dir = pricingProject();
  writeFileSync(join(dir, 'src', 'price.mjs'), 'export function total(qty) {\n  return qty * 499;\n}\n');
  const res = spawnSync(process.execPath, [BIN, 'mutate', dir, '--json'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).error.code, 'not-holding');
});
