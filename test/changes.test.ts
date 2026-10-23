import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { amendExpect } from '../src/changes.ts';
import { lint } from '../src/lint.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

const INVENTORY = `version: 0
capabilities:
  - { id: checkout.create, statement: A shopper can pay for a cart and get one receipt, intent: buy-without-surprises, surfaces: [POST /checkout] }
  - { id: health.read, statement: An operator can see that the service answers, surfaces: [GET /health] }
`;

const CHANGE = `version: 0
changes:
  - id: show-currency
    because: International shoppers ask support which currency they were charged
    reaches: [checkout.create]
    amends:
      - outcome: checkout.payment-confirmed
        expect: { body: { currency: { matches: "^[A-Z]{3}$" } } }
    rules_out: [new effects, new hosts, new routes, new dependencies]
`;

const oodle = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', OODLE_QUIET: '1' } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
};

/** The checkout example in a git repo whose base already has the change merged, unless `merged` is false. */
function repo(merged = true): { dir: string; edit: (file: string, from: string, to: string) => void; check: () => any; git: (...a: string[]) => string } {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-changes-')), 'repo');
  cpSync(EXAMPLE, dir, { recursive: true });
  writeFileSync(join(dir, 'oodlc', 'inventory.yaml'), INVENTORY);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { yaml: '*' } }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  if (merged) {
    mkdirSync(join(dir, 'oodlc', 'changes'));
    writeFileSync(join(dir, 'oodlc', 'changes', 'show-currency.yaml'), CHANGE);
  }
  git('add', '.');
  git('commit', '-qm', 'Intent: show currency (#12)');
  const edit = (file: string, from: string, to: string) => {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    assert.notEqual(before.replace(from, to), before, `edit did not apply to ${file}`);
    writeFileSync(path, before.replace(from, to));
  };
  const check = () => {
    const r = oodle(['check', '--json'], dir);
    return { code: r.code, ...JSON.parse(r.stdout) };
  };
  return { dir, edit, check, git };
}

const ADD_CURRENCY = ["body: { order_id: order.id, status: 'confirmed', total_cents }", "body: { order_id: order.id, status: 'confirmed', total_cents, currency: 'USD' }"] as const;

test('amendExpect: body fields merge by key, effects by kind, the rest is replaced', () => {
  const base = { status: 200, body: { status: 'confirmed', order_id: { exists: true } }, effects: [{ kind: 'email.sent', count: 1 }, { kind: 'payment.capture', count: 1 }] };
  assert.deepEqual(amendExpect(base, { status: 201, body: { currency: 'USD', order_id: { matches: '^ord_' } }, effects: [{ kind: 'email.sent', count: 2 }] }), {
    status: 201,
    body: { status: 'confirmed', order_id: { matches: '^ord_' }, currency: 'USD' },
    effects: [{ kind: 'payment.capture', count: 1 }, { kind: 'email.sent', count: 2 }],
  });
});

test('a code pull request that does exactly what a merged change says passes, and cites it', () => {
  const r = repo();
  r.edit('src/checkout.ts', ...ADD_CURRENCY);
  const d = r.check();
  assert.equal(d.code, 0, JSON.stringify(d.changes));
  assert.equal(d.blocking, 0);
  const o = d.outcomes.find((x: any) => x.id === 'checkout.payment-confirmed');
  assert.equal(o.status, 'changed');
  assert.equal(o.covered_by, 'show-currency');
  assert.deepEqual(d.changes.used.map((c: any) => [c.id, c.covers]), [['show-currency', ['checkout.payment-confirmed']]]);
  assert.match(d.changes.used[0].origin, /Intent: show currency \(#12\)/);
});

test('code that doesn\'t yet do what the change says still blocks, and says what is missing', () => {
  const r = repo();
  r.edit('src/checkout.ts', ADD_CURRENCY[0], ADD_CURRENCY[1].replace("'USD'", "'usd'"));
  const d = r.check();
  assert.equal(d.code, 1);
  const o = d.outcomes.find((x: any) => x.id === 'checkout.payment-confirmed');
  assert.equal(o.blocking, true);
  assert.ok(o.details.some((x: string) => /not yet what change show-currency says: .*currency/.test(x)), o.details.join('\n'));
});

test('using a change binds the pull request to its scope: what moves outside it blocks as outside intent', () => {
  const r = repo();
  r.edit('src/checkout.ts', ...ADD_CURRENCY);
  // A behavior in another capability, a new route and a new dependency, all ruled out.
  r.edit('src/app.ts', 'body: { ok: true }', "body: { ok: true, version: '2' }");
  r.edit('src/app.ts', "{ method: 'POST', path: '/checkout', handler: checkout },", "{ method: 'POST', path: '/checkout', handler: checkout },\n    { method: 'GET', path: '/promo', handler: async () => ({ status: 200, body: {} }) },");
  writeFileSync(join(r.dir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { yaml: '*', 'left-pad': '*' } }));
  const d = r.check();
  assert.equal(d.code, 1);
  const outside = d.changes.outside.join('\n');
  assert.match(outside, /behavior ops\.health \(changed\), in health\.read, is outside show-currency, which reaches checkout\.create/);
  assert.match(outside, /a new route, GET \/promo, which show-currency rules out/);
  assert.match(outside, /a new dependency, left-pad, which show-currency rules out/);
});

test('a change added in the same pull request covers nothing: it is proposed, for review', () => {
  const r = repo(false);
  mkdirSync(join(r.dir, 'oodlc', 'changes'));
  writeFileSync(join(r.dir, 'oodlc', 'changes', 'show-currency.yaml'), CHANGE);
  r.edit('src/checkout.ts', ...ADD_CURRENCY);
  const d = r.check();
  assert.equal(d.code, 1);
  assert.deepEqual(d.changes.proposed.map((c: any) => c.id), ['show-currency']);
  assert.equal(d.outcomes.find((x: any) => x.id === 'checkout.payment-confirmed').covered_by, undefined);
});

test('fold: once shipped, the amendment goes into the catalog, the change is archived, and that redefinition is covered', () => {
  const r = repo();
  r.edit('src/checkout.ts', ...ADD_CURRENCY);
  r.git('commit', '-qam', 'Show the currency (#13)');
  const fold = oodle(['changes', 'fold', 'show-currency', '--json'], r.dir);
  assert.equal(fold.code, 0, fold.stdout + fold.stderr);
  assert.ok(existsSync(join(r.dir, 'oodlc', 'changes', 'archive', 'show-currency.yaml')));
  assert.match(readFileSync(join(r.dir, 'oodlc', 'checkout.yaml'), 'utf8'), /currency:\s*\n?\s*matches: \^\[A-Z\]\{3\}\$/);
  const d = r.check();
  assert.equal(d.code, 0, JSON.stringify(d.outcomes.filter((o: any) => o.status !== 'held')));
  const o = d.outcomes.find((x: any) => x.id === 'checkout.payment-confirmed');
  assert.equal(o.status, 'redefined');
  assert.equal(o.covered_by, 'show-currency');
  assert.equal(loadCatalog(r.dir, loadConfig(r.dir)).changes.length, 0);
});

test('a hand edit that says more than the change does is not covered', () => {
  const r = repo();
  r.edit('src/checkout.ts', ...ADD_CURRENCY);
  r.edit('oodlc/checkout.yaml', 'status: confirmed', 'status: confirmed\n        currency: USD');
  const d = r.check();
  const o = d.outcomes.find((x: any) => x.id === 'checkout.payment-confirmed');
  assert.equal(o.blocking, true);
  assert.ok(o.details.some((x: string) => /fold it with `oodle changes fold show-currency`/.test(x)));
});

test('a change can retire an outcome', () => {
  const r = repo(false);
  mkdirSync(join(r.dir, 'oodlc', 'changes'));
  writeFileSync(join(r.dir, 'oodlc', 'changes', 'retire.yaml'), 'version: 0\nchanges:\n  - id: retire-provider-down\n    because: The provider now queues payments, so it is never down for callers\n    amends: [{ outcome: checkout.payment-provider-down, remove: true }]\n');
  r.git('add', '.');
  r.git('commit', '-qm', 'Intent: retire provider-down (#14)');
  const path = join(r.dir, 'oodlc', 'checkout.yaml');
  const lines = readFileSync(path, 'utf8').split('\n');
  writeFileSync(path, lines.slice(0, lines.findIndex((l) => l.includes('id: checkout.payment-provider-down'))).join('\n') + '\n');
  const d = r.check();
  assert.equal(d.code, 0, JSON.stringify(d.changes));
  assert.equal(d.outcomes.find((x: any) => x.id === 'checkout.payment-provider-down').covered_by, 'retire-provider-down');
});

test('lint: a change must reach and amend what exists, and lives in oodlc/changes/', () => {
  const r = repo();
  writeFileSync(join(r.dir, 'oodlc', 'changes', 'bad.yaml'), 'version: 0\nchanges:\n  - { id: bad, because: x, reaches: [nope], amends: [{ outcome: missing }, { constraint: no-charge-without-order, expect: { status: 200 } }] }\n');
  const errors = lint(loadCatalog(r.dir, loadConfig(r.dir))).errors.join('\n');
  assert.match(errors, /reaches unknown capability "nope"/);
  assert.match(errors, /amends unknown outcome "missing"/);
  assert.match(errors, /no-charge-without-order is a constraint; amend its check, not an expect/);
  writeFileSync(join(r.dir, 'oodlc', 'misplaced.yaml'), 'version: 0\nchanges:\n  - { id: here, because: x }\n');
  assert.throws(() => loadCatalog(r.dir, loadConfig(r.dir)), /changes go in oodlc\/changes\//);
});

test('cli: lists changes with where they were agreed, and briefs an agent on one', () => {
  const r = repo();
  const list = JSON.parse(oodle(['changes', '--json'], r.dir).stdout);
  assert.equal(list.changes[0].id, 'show-currency');
  assert.match(list.changes[0].origin, /Intent: show currency/);
  const brief = oodle(['changes', 'brief', 'show-currency'], r.dir).stdout;
  assert.match(brief, /Why: International shoppers ask support/);
  assert.match(brief, /Must hold after: .*"currency":\{"matches":"\^\[A-Z\]\{3\}\$"\}/);
  assert.match(brief, /- new dependencies/);
  assert.equal(JSON.parse(oodle(['changes', 'brief', 'nope', '--json'], r.dir).stdout).error.code, 'no-match');
});
