import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runProject } from '../src/runner.ts';
import { diffRuns } from '../src/diff.ts';
import { diffMarkdown } from '../src/report.ts';
import { lint } from '../src/lint.ts';
import { loadCatalog, loadConfig } from '../src/catalog.ts';

const EXAMPLE = resolve(import.meta.dirname, '..', 'examples', 'checkout');

function copyExample(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

function edit(dir: string, file: string, from: string | RegExp, to: string) {
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(after, before, `edit did not apply to ${file}`);
  writeFileSync(path, after);
}

async function diffAfter(mutate: (dir: string) => void) {
  const head = copyExample();
  mutate(head);
  const report = diffRuns(await runProject(EXAMPLE), await runProject(head));
  return {
    report,
    byId: (id: string) => report.outcomes.find((o) => o.id === id)!,
    behavior: (id: string) => report.behaviors.find((b) => b.id === id)!,
  };
}

test('baseline: every outcome holds, no behavior drifts, nothing is unknown', async () => {
  const run = await runProject(EXAMPLE);
  assert.deepEqual(run.observations.filter((o) => o.failures.length), []);
  assert.equal(run.gaps.length, 0);
  assert.equal(run.lint.errors.length, 0);
  assert.equal(run.observations.length, 7); // 3 conditions + 3 single-run outcomes + 1 behavior
  assert.equal(run.observations.filter((o) => o.kind === 'behavior').length, 1);
});

test('refactor: internal changes only, nothing blocks', async () => {
  const { report, byId } = await diffAfter((dir) => {
    edit(dir, 'src/checkout.ts', "'internal.audit'", "'internal.audit_log'");
    edit(dir, 'src/checkout.ts', /const order = /, 'const newOrder = ');
    edit(dir, 'src/checkout.ts', /order\.id/g, 'newOrder.id');
    edit(dir, 'src/checkout.ts', '[...(ctx.state.orders ?? []), order]', '[...(ctx.state.orders ?? []), newOrder]');
  });
  assert.equal(report.blocking, 0);
  assert.ok(report.outcomes.every((o) => o.status === 'held'), JSON.stringify(report.outcomes, null, 2));
  assert.ok(byId('checkout.payment-confirmed').behavior.some((c) => c.includes('internal.audit_log')));
  assert.ok(byId('checkout.payment-confirmed').behavior.includes('[first_purchase] effects: internal.audit renamed to internal.audit_log'));
  const md = diffMarkdown(report);
  assert.match(md, /1 behavior changes/);
  assert.equal(md.match(/renamed to internal\.audit_log/g)?.length, 1, md);
});

test('renamed response field: outcome broken and blocking', async () => {
  const { report, byId } = await diffAfter((dir) => edit(dir, 'src/checkout.ts', '{ order_id: order.id,', '{ orderId: order.id,'));
  const b = byId('checkout.payment-confirmed');
  assert.equal(b.status, 'broken');
  assert.equal(b.blocking, true);
  assert.ok(b.details.some((d) => d.includes('body.order_id: missing')));
  assert.equal(report.blocking, 1);
});

test('new route nobody described: unknown, proposed as an observed behavior', async () => {
  const { report } = await diffAfter((dir) => {
    edit(
      dir,
      'src/app.ts',
      "{ method: 'POST', path: '/checkout', handler: checkout },",
      "{ method: 'POST', path: '/checkout', handler: checkout },\n    { method: 'GET', path: '/orders/:id', handler: async (c, _r, p) => { const o = (c.state.orders ?? []).find((x: any) => x.id === p.id); return o ? { status: 200, body: o } : { status: 404, body: { error: 'order_not_found' } }; } },",
    );
  });
  assert.equal(report.blocking, 0);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].route, 'GET /orders/:id');
  assert.equal(report.gaps[0].probe.status, 404);
  assert.deepEqual(report.gaps[0].proposal.observed, { status: 404 });
  assert.equal('expect' in report.gaps[0].proposal, false);
  assert.match(diffMarkdown(report), /Unknown: routes no outcome or behavior describes/);
});

test('constraint catches a bug the expectations miss', async () => {
  const { byId } = await diffAfter((dir) => edit(dir, 'src/checkout.ts', 'payment_id: payment.id,', 'payment_id: null,'));
  const b = byId('checkout.payment-confirmed');
  assert.equal(b.status, 'broken');
  assert.ok(b.details.some((d) => d.includes('no-charge-without-order')));
});

test('extra field on an outcome response: changed, needs review', async () => {
  const { byId } = await diffAfter((dir) => edit(dir, 'src/checkout.ts', "status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'usd' }"));
  const b = byId('checkout.payment-confirmed');
  assert.equal(b.status, 'changed');
  assert.equal(b.blocking, true);
  assert.ok(b.details.some((d) => d.includes('body.currency added')));
});

test('editing an outcome expectation: redefined, needs approval', async () => {
  const { byId } = await diffAfter((dir) => edit(dir, 'catalog/checkout.yaml', 'latency_ms_max: 2000', 'latency_ms_max: 3000'));
  const b = byId('checkout.payment-confirmed');
  assert.equal(b.status, 'redefined');
  assert.equal(b.blocking, true);
});

test('lint: outcome without an intent is an error', () => {
  const dir = copyExample();
  edit(dir, 'catalog/checkout.yaml', 'intent: buy-without-surprises\n    statement: After', 'statement: After');
  const result = lint(loadCatalog(dir, loadConfig(dir)));
  assert.ok(result.errors.some((e) => e.includes('checkout.payment-confirmed: outcome has no intent')));
});

test('schema: unknown fields are rejected', () => {
  const dir = copyExample();
  edit(dir, 'catalog/ops.yaml', 'boundary: internal', 'boundary: internal\n    owner: platform');
  assert.throws(() => loadCatalog(dir, loadConfig(dir)), /must NOT have additional properties \(owner\)/);
});

test('behavior drift: reported, never blocking', async () => {
  const { report, behavior } = await diffAfter((dir) => edit(dir, 'src/app.ts', 'body: { ok: true }', "body: { ok: true, version: '2' }"));
  assert.equal(report.blocking, 0);
  const b = behavior('ops.health');
  assert.equal(b.status, 'changed');
  assert.ok(b.details.some((d) => d.includes('body.version added')));
  assert.match(diffMarkdown(report), /Behavior changes \(report only\)/);
});

test('behavior that no longer matches its snapshot: drift, not failure', async () => {
  const { report, behavior } = await diffAfter((dir) => edit(dir, 'src/app.ts', 'body: { ok: true }', 'body: { ok: false }'));
  assert.equal(report.blocking, 0);
  assert.ok(behavior('ops.health').details.some((d) => d.startsWith('drift: [default] body.ok')));
});

test('promoting a behavior to an outcome: new outcome, behavior marked promoted, nothing blocks', async () => {
  const { report, byId, behavior } = await diffAfter((dir) => {
    writeFileSync(
      join(dir, 'catalog/ops.yaml'),
      'version: 0\noutcomes:\n  - id: ops.health\n    intent: buy-without-surprises\n    statement: Health endpoint answers ok\n    boundary: external\n    trigger: { http: GET /health }\n    expect: { status: 200, body: { ok: true } }\n',
    );
  });
  assert.equal(report.blocking, 0);
  assert.equal(byId('ops.health').status, 'new');
  assert.equal(behavior('ops.health').status, 'removed');
  assert.deepEqual(behavior('ops.health').details, ['promoted to an outcome']);
});

test('demoting an outcome to a behavior: removed outcome blocks', async () => {
  const { byId } = await diffAfter((dir) => {
    const path = join(dir, 'catalog/checkout.yaml');
    const lines = readFileSync(path, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.includes('id: checkout.payment-provider-down'));
    writeFileSync(path, lines.slice(0, start).join('\n') + '\n');
  });
  const o = byId('checkout.payment-provider-down');
  assert.equal(o.status, 'removed');
  assert.equal(o.blocking, true);
});

test('schema: an id cannot be both an outcome and a behavior', () => {
  const dir = copyExample();
  edit(dir, 'catalog/ops.yaml', 'id: ops.health', 'id: checkout.empty-cart-rejected');
  assert.throws(() => loadCatalog(dir, loadConfig(dir)), /is both an outcome and a behavior/);
});

test('lint: a behavior crossing the boundary asks for a promotion decision', () => {
  const dir = copyExample();
  edit(dir, 'catalog/ops.yaml', 'boundary: internal', 'boundary: customer');
  const result = lint(loadCatalog(dir, loadConfig(dir)));
  assert.ok(result.warnings.some((w) => w.includes('ops.health: behavior crosses the customer boundary')));
});

test('constraint violated on a behavior run: blocks, though the behavior itself never would', async () => {
  const { report, behavior } = await diffAfter((dir) =>
    edit(dir, 'src/app.ts', "handler: async () => ({ status: 200, body: { ok: true } })", "handler: async (c) => { await c.effects.call('payment.capture', { amount_cents: 1 }); return { status: 200, body: { ok: true } }; }"),
  );
  const b = behavior('ops.health');
  assert.equal(b.blocking, true);
  assert.ok(b.violations.some((v) => v.includes('no-charge-without-order')));
  assert.equal(report.blocking, 1);
  assert.match(diffMarkdown(report), /Constraint violations \(blocking\)/);
});

test('constraint violated on a route nobody described: blocks', async () => {
  const { report } = await diffAfter((dir) =>
    edit(
      dir,
      'src/app.ts',
      "{ method: 'POST', path: '/checkout', handler: checkout },",
      "{ method: 'POST', path: '/checkout', handler: checkout },\n    { method: 'POST', path: '/quick-buy', handler: async (c) => { await c.effects.call('payment.capture', { amount_cents: 2500 }); return { status: 200, body: {} }; } },",
    ),
  );
  assert.equal(report.gaps.length, 1);
  assert.ok(report.gaps[0].violations.some((v) => v.includes('no-charge-without-order')));
  assert.equal(report.blocking, 1);
});

test('constraint check that throws fails closed', async () => {
  const { byId } = await diffAfter((dir) => edit(dir, 'catalog/constraints.yaml', ".every(e => (state.orders || [])", ".every(e => (state.missing.orders || [])"));
  const o = byId('checkout.payment-confirmed');
  assert.equal(o.blocking, true);
  assert.ok(o.details.some((d) => d.includes('constraint receipt-only-for-real-orders errored')));
});

test('loosening a constraint: redefined, needs approval', async () => {
  const { report } = await diffAfter((dir) => edit(dir, 'catalog/constraints.yaml', "e.result.status === 'succeeded'", "e.result.status === 'never'"));
  const c = report.constraints.find((x) => x.id === 'no-charge-without-order')!;
  assert.equal(c.status, 'redefined');
  assert.equal(c.blocking, true);
  assert.equal(report.blocking, 1);
});

test('cli: oodle check diffs the working tree against a git ref', () => {
  const repo = mkdtempSync(join(tmpdir(), 'oodle-git-'));
  cpSync(EXAMPLE, join(repo, 'app'), { recursive: true });
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  edit(join(repo, 'app'), 'src/checkout.ts', '{ order_id: order.id,', '{ orderId: order.id,');

  const cli = resolve(import.meta.dirname, '..', 'bin', 'oodle.js');
  const res = spawnSync(process.execPath, [cli, 'check', join(repo, 'app'), '--base-ref', 'HEAD', '--md', join(repo, 'diff.md')], { encoding: 'utf8' });
  assert.equal(res.status, 1, res.stderr + res.stdout);
  assert.match(readFileSync(join(repo, 'diff.md'), 'utf8'), /1 blocking/);
});

test('effect diffs read as added, removed, renamed, recounted or changed at a path', async () => {
  const { jsonDiff } = await import('../src/expect.ts');
  const e = (kind: string, payload: object) => ({ kind, payload });
  const base = [e('internal.audit', { order_id: 'ord_1' })];
  assert.deepEqual(jsonDiff({ effects: base }, { effects: [e('internal.audit_log', { order_id: 'ord_1' })] }), ['effects: internal.audit renamed to internal.audit_log']);
  assert.deepEqual(jsonDiff({ effects: base }, { effects: [e('internal.audit', { order_id: 'ord_2' })] }), ['effects[internal.audit].payload.order_id: "ord_1" → "ord_2"']);
  assert.deepEqual(jsonDiff({ effects: base }, { effects: [...base, e('internal.metric', {})] }), ['effects: internal.metric now emitted']);
  assert.deepEqual(jsonDiff({ effects: base }, { effects: [] }), ['effects: internal.audit no longer emitted']);
  assert.deepEqual(jsonDiff({ effects: base }, { effects: [...base, ...base] }), ['effects: internal.audit emitted ×1 → ×2']);
});
