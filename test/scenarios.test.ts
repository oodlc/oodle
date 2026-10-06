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
  const { byId } = await diffAfter((dir) => edit(dir, 'oodlc/checkout.yaml', 'latency_ms_max: 2000', 'latency_ms_max: 3000'));
  const b = byId('checkout.payment-confirmed');
  assert.equal(b.status, 'redefined');
  assert.equal(b.blocking, true);
});

test('approval: an approved change to a promise does not block, and says who approved it', async () => {
  const head = copyExample();
  edit(head, 'src/checkout.ts', "status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'usd' }");
  const [base, after] = [await runProject(EXAMPLE), await runProject(head)];
  const pending = diffRuns(base, after).outcomes.find((o) => o.id === 'checkout.payment-confirmed')!;
  assert.match(pending.fingerprint!, /^[0-9a-f]{8}$/);
  assert.match(diffMarkdown(diffRuns(base, after)), new RegExp(`/oodle approve checkout\\.payment-confirmed@${pending.fingerprint}`));

  const report = diffRuns(base, after, [{ id: pending.id, fingerprint: pending.fingerprint!, by: 'reviewer' }]);
  const approved = report.outcomes.find((o) => o.id === pending.id)!;
  assert.equal(report.blocking, 0);
  assert.equal(approved.status, 'changed');
  assert.equal(approved.blocking, false);
  assert.deepEqual(approved.approved_by, ['reviewer']);
  assert.deepEqual(report.approvals.applied.map((a) => a.id), [pending.id]);
  assert.match(diffMarkdown(report), /changed ✅ approved by reviewer/);
});

test('approval: a push that changes what was approved makes the approval stale', async () => {
  const head = copyExample();
  edit(head, 'src/checkout.ts', "status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'usd' }");
  const base = await runProject(EXAMPLE);
  const { fingerprint } = diffRuns(base, await runProject(head)).outcomes.find((o) => o.id === 'checkout.payment-confirmed')!;
  // Same shape of change ("body.currency added"), different value: not what was approved.
  // A fresh copy, since an app module is imported once per process.
  const pushed = copyExample();
  edit(pushed, 'src/checkout.ts', "status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'eur' }");
  const report = diffRuns(base, await runProject(pushed), [{ id: 'checkout.payment-confirmed', fingerprint: fingerprint! }]);
  assert.equal(report.blocking, 1);
  assert.equal(report.approvals.stale.length, 1);
  assert.match(report.approvals.stale[0].reason, /different now/);
});

test('approval: a broken outcome or a violated constraint is never approvable', async () => {
  const { report, byId } = await diffAfter((dir) => edit(dir, 'src/checkout.ts', '{ order_id: order.id,', '{ orderId: order.id,'));
  assert.equal(byId('checkout.payment-confirmed').status, 'broken');
  assert.equal(byId('checkout.payment-confirmed').fingerprint, undefined);
  const head = copyExample();
  edit(head, 'src/checkout.ts', '{ order_id: order.id,', '{ orderId: order.id,');
  const forced = diffRuns(await runProject(EXAMPLE), await runProject(head), [{ id: 'checkout.payment-confirmed', fingerprint: '00000000' }]);
  assert.equal(forced.blocking, report.blocking);
  assert.match(forced.approvals.stale[0].reason, /broken, which can't be approved/);
});

test('approval: redefining an outcome and approving the redefinition unblocks it', async () => {
  const head = copyExample();
  edit(head, 'oodlc/checkout.yaml', 'latency_ms_max: 2000', 'latency_ms_max: 3000');
  const base = await runProject(EXAMPLE);
  const after = await runProject(head);
  const d = diffRuns(base, after).outcomes.find((o) => o.id === 'checkout.payment-confirmed')!;
  assert.equal(d.status, 'redefined');
  assert.equal(diffRuns(base, after, [{ id: d.id, fingerprint: d.fingerprint! }]).blocking, 0);
});

test('approval: the Action keeps approvals by maintainers other than the author', async () => {
  // @ts-ignore: plain ESM script without types
  const { collect } = await import('../scripts/approvals.mjs');
  const item = (login: string, body: string, association = 'MEMBER', extra = {}) => ({ user: { login, type: 'User' }, author_association: association, body, ...extra });
  const items = [
    item('reviewer', 'Looks right.\n/oodle approve checkout.payment-confirmed@1a2b3c4d no-charge-without-order@deadbeef'),
    item('author', '/oodle approve checkout.payment-confirmed@1a2b3c4d'),
    item('drive-by', '/oodle approve checkout.payment-confirmed@1a2b3c4d', 'CONTRIBUTOR'),
    item('dismissed', '/oodle approve checkout.payment-confirmed@1a2b3c4d', 'MEMBER', { state: 'DISMISSED' }),
    { user: { login: 'bot', type: 'Bot' }, author_association: 'MEMBER', body: '/oodle approve checkout.payment-confirmed@1a2b3c4d' },
    item('quoter', '> /oodle approve `checkout.payment-confirmed@1a2b3c4d`'),
    item('typo', '/oodle approve checkout.payment-confirmed@zzz'),
  ];
  assert.deepEqual(collect(items, { author: 'Author', allowSelf: false }), [
    { id: 'checkout.payment-confirmed', fingerprint: '1a2b3c4d', by: 'reviewer' },
    { id: 'no-charge-without-order', fingerprint: 'deadbeef', by: 'reviewer' },
    { id: 'checkout.payment-confirmed', fingerprint: '1a2b3c4d', by: 'quoter' },
  ]);
  assert.ok(collect(items, { author: 'author', allowSelf: true }).some((a: { by: string }) => a.by === 'author'));
});

test('approval: a private org member, labelled CONTRIBUTOR, counts when their permission is write', async () => {
  // @ts-ignore: plain ESM script without types
  const { collect, toLookUp } = await import('../scripts/approvals.mjs');
  const item = (login: string, association: string) => ({ user: { login, type: 'User' }, author_association: association, body: '/oodle approve checkout.payment-confirmed@1a2b3c4d' });
  const items = [item('Private-Member', 'CONTRIBUTOR'), item('reader', 'CONTRIBUTOR'), item('member', 'MEMBER'), { user: { login: 'chatter', type: 'User' }, author_association: 'NONE', body: 'Nice.' }];
  assert.deepEqual(toLookUp(items), ['Private-Member', 'reader']);
  const by = (permissions: Record<string, string>) => collect(items, { author: 'someone', allowSelf: false, permissions }).map((a: { by: string }) => a.by);
  assert.deepEqual(by({ 'private-member': 'admin', reader: 'read' }), ['Private-Member', 'member']);
  assert.deepEqual(by({}), ['member']);
});

test('lint: outcome without an intent is an error', () => {
  const dir = copyExample();
  edit(dir, 'oodlc/checkout.yaml', 'intent: buy-without-surprises\n    statement: After', 'statement: After');
  const result = lint(loadCatalog(dir, loadConfig(dir)));
  assert.ok(result.errors.some((e) => e.includes('checkout.payment-confirmed: outcome has no intent')));
});

test('schema: unknown fields are rejected', () => {
  const dir = copyExample();
  edit(dir, 'oodlc/ops.yaml', 'boundary: internal', 'boundary: internal\n    owner: platform');
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
      join(dir, 'oodlc/ops.yaml'),
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
    const path = join(dir, 'oodlc/checkout.yaml');
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
  edit(dir, 'oodlc/ops.yaml', 'id: ops.health', 'id: checkout.empty-cart-rejected');
  assert.throws(() => loadCatalog(dir, loadConfig(dir)), /is both an outcome and a behavior/);
});

test('lint: a behavior crossing the boundary asks for a promotion decision', () => {
  const dir = copyExample();
  edit(dir, 'oodlc/ops.yaml', 'boundary: internal', 'boundary: customer');
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
  const { byId } = await diffAfter((dir) => edit(dir, 'oodlc/constraints.yaml', ".every(e => (state.orders || [])", ".every(e => (state.missing.orders || [])"));
  const o = byId('checkout.payment-confirmed');
  assert.equal(o.blocking, true);
  assert.ok(o.details.some((d) => d.includes('constraint receipt-only-for-real-orders errored')));
});

test('loosening a constraint: redefined, needs approval', async () => {
  const { report } = await diffAfter((dir) => edit(dir, 'oodlc/constraints.yaml', "e.result.status === 'succeeded'", "e.result.status === 'never'"));
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

test('cli: oodle check --approve unblocks an intended change, and refuses a malformed token', () => {
  const repo = mkdtempSync(join(tmpdir(), 'oodle-git-'));
  cpSync(EXAMPLE, join(repo, 'app'), { recursive: true });
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  edit(join(repo, 'app'), 'src/checkout.ts', "status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'usd' }");

  const cli = resolve(import.meta.dirname, '..', 'bin', 'oodle.js');
  const check = (...extra: string[]) => spawnSync(process.execPath, [cli, 'check', join(repo, 'app'), '--base-ref', 'HEAD', '--json', ...extra], { encoding: 'utf8' });
  const pending = JSON.parse(check().stdout);
  const d = pending.outcomes.find((o: { fingerprint?: string }) => o.fingerprint);
  const approved = check('--approve', `${d.id}@${d.fingerprint}`);
  assert.equal(approved.status, 0, approved.stdout);
  assert.equal(JSON.parse(approved.stdout).approvals.applied.length, 1);

  writeFileSync(join(repo, 'approvals.json'), JSON.stringify([{ id: d.id, fingerprint: d.fingerprint, by: 'reviewer' }]));
  const fromFile = JSON.parse(check('--approvals', join(repo, 'approvals.json')).stdout);
  assert.deepEqual(fromFile.outcomes.find((o: { id: string }) => o.id === d.id).approved_by, ['reviewer']);

  const bad = check('--approve', d.id);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, 'usage');
});

test('cli: the change that adds Oodle passes: the base promised nothing, so every outcome is new', () => {
  const repo = mkdtempSync(join(tmpdir(), 'oodle-git-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'before Oodle\n');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  cpSync(EXAMPLE, join(repo, 'app'), { recursive: true });

  const cli = resolve(import.meta.dirname, '..', 'bin', 'oodle.js');
  const res = spawnSync(process.execPath, [cli, 'check', join(repo, 'app'), '--base-ref', 'main', '--json'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout);
  const doc = JSON.parse(res.stdout);
  assert.match(doc.base, /before Oodle/);
  assert.deepEqual([...new Set(doc.outcomes.map((o: { status: string }) => o.status))], ['new']);
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

// ── Conditions with their own expectations, and the security pack (docs/decisions/0004) ──

const addRoute = (dir: string, route: string) =>
  edit(dir, 'src/app.ts', "{ method: 'POST', path: '/checkout', handler: checkout },", `{ method: 'POST', path: '/checkout', handler: checkout },\n    ${route},`);

/** Checkout behind a bearer token: the config sends one by default, and the outcome says what happens without it. */
function withAuth(dir: string, enforce: boolean) {
  edit(dir, 'oodlc/config.yaml', 'defaults:\n  given:\n', 'defaults:\n  given:\n    headers: { authorization: Bearer c1 }\n');
  edit(dir, 'oodlc/checkout.yaml', 'conditions: [first_purchase, returning_customer, payment_provider_slow]', 'conditions: [first_purchase, returning_customer, payment_provider_slow, security.no-credentials]');
  edit(dir, 'oodlc/checkout.yaml', '    constraints: [no-charge-without-order, receipt-only-for-real-orders]', [
    '    when:',
    '      security.no-credentials:',
    '        status: 401',
    '        body: { error: unauthorized }',
    '        effects: [{ kind: payment.capture, count: 0 }]',
    '    constraints: [no-charge-without-order, receipt-only-for-real-orders]',
  ].join('\n'));
  if (enforce) {
    edit(dir, 'src/checkout.ts', 'const body = (req.body ?? {}) as CheckoutBody;', "if (!req.headers?.authorization) return { status: 401, body: { error: 'unauthorized' } };\n  const body = (req.body ?? {}) as CheckoutBody;");
  }
}

const problems = (run: Awaited<ReturnType<typeof runProject>>, id: string, condition: string) => {
  const o = run.observations.find((x) => x.id === id && x.condition === condition)!;
  return [...o.failures, ...o.violations];
};

test('when: a condition can expect something else, e.g. 401 without credentials', async () => {
  const open = copyExample();
  withAuth(open, false);
  const leaky = await runProject(open);
  assert.ok(problems(leaky, 'checkout.payment-confirmed', 'security.no-credentials').includes('status: expected 401, got 200'));
  assert.deepEqual(problems(leaky, 'checkout.payment-confirmed', 'first_purchase'), []);

  const closed = copyExample();
  withAuth(closed, true);
  const run = await runProject(closed);
  assert.deepEqual(run.observations.filter((o) => o.failures.length || o.violations.length), []);
});

test('when: editing a per-condition expectation is a redefinition', async () => {
  const head = copyExample();
  withAuth(head, true);
  const base = copyExample();
  withAuth(base, true);
  edit(head, 'oodlc/checkout.yaml', 'status: 401', 'status: { gte: 400, lte: 403 }');
  const report = diffRuns(await runProject(base), await runProject(head));
  assert.equal(report.outcomes.find((o) => o.id === 'checkout.payment-confirmed')!.status, 'redefined');
});

test('lint: when names a condition the outcome does not run under', () => {
  const dir = copyExample();
  withAuth(dir, true);
  edit(dir, 'oodlc/checkout.yaml', ', security.no-credentials]', ']');
  const result = lint(loadCatalog(dir, loadConfig(dir)));
  assert.ok(result.errors.some((e) => e.includes('"when" names security.no-credentials')), result.errors.join('\n'));
});

test('security.extra-fields: a mass-assignment bug breaks the outcome', async () => {
  const pack = (dir: string) => edit(dir, 'oodlc/checkout.yaml', 'conditions: [first_purchase, returning_customer, payment_provider_slow]', 'conditions: [first_purchase, security.extra-fields]');
  const safeDir = copyExample();
  pack(safeDir);
  const safe = await runProject(safeDir);
  assert.deepEqual(problems(safe, 'checkout.payment-confirmed', 'security.extra-fields'), []);

  // A fresh copy: the app's modules are cached per path.
  const dir = copyExample();
  pack(dir);
  edit(dir, 'src/checkout.ts', 'const { total_cents, unknown } = priceCart(', 'const priced = priceCart(');
  edit(dir, 'src/checkout.ts', "if (unknown.length)", "const unknown = priced.unknown;\n  const total_cents = (body as any).total_cents ?? priced.total_cents;\n  if (unknown.length)");
  const run = await runProject(dir);
  const found = problems(run, 'checkout.payment-confirmed', 'security.extra-fields');
  assert.ok(found.includes('body.total_cents: expected 6200, got 0'), JSON.stringify(found));
  assert.deepEqual(problems(run, 'checkout.payment-confirmed', 'first_purchase'), []);
});

test('security.replayed: a request sent twice must not charge twice', async () => {
  const dir = copyExample();
  edit(dir, 'oodlc/checkout.yaml', 'conditions: [first_purchase, returning_customer, payment_provider_slow]', 'conditions: [first_purchase, security.replayed]');
  writeFileSync(join(dir, 'oodlc', 'idempotency.yaml'), "version: 0\nconstraints:\n  - id: charge-once\n    statement: One request never captures more than one payment, however often it is sent\n    check: effects.filter(e => e.kind === 'payment.capture').length <= 1\n");
  const run = await runProject(dir);
  assert.ok(problems(run, 'checkout.payment-confirmed', 'security.replayed').some((p) => p.includes('constraint charge-once violated')));
  assert.deepEqual(problems(run, 'checkout.payment-confirmed', 'first_purchase'), []);
});

test('probe.conditions: an undescribed route that charges without credentials blocks', async () => {
  const { report } = await diffAfter((dir) => {
    edit(dir, 'oodlc/config.yaml', 'defaults:\n  given:\n', 'probe:\n  conditions: [security.no-credentials, security.injection]\ndefaults:\n  given:\n    headers: { authorization: Bearer c1 }\n');
    writeFileSync(join(dir, 'oodlc', 'auth.yaml'), "version: 0\nconstraints:\n  - id: no-side-effects-without-credentials\n    statement: A request without credentials never causes an external effect\n    check: >-\n      !!(request.headers && request.headers.authorization) || effects.every(e => e.boundary === 'internal')\n");
    addRoute(dir, "{ method: 'POST', path: '/tip', handler: async (c) => { await c.effects.call('payment.capture', { amount_cents: 100 }); c.state.orders = [{ id: 'o', payment_id: 'pay_1' }]; return { status: 200, body: {} }; } }");
  });
  const gap = report.gaps.find((g) => g.route === 'POST /tip')!;
  assert.deepEqual(gap.probed_under, ['security.no-credentials', 'security.injection']);
  assert.deepEqual(gap.violations, ['[security.no-credentials] constraint no-side-effects-without-credentials violated: A request without credentials never causes an external effect']);
  assert.ok(report.blocking >= 1);
});

test('security.extra-fields: a body __proto__ that reaches Object.prototype is a violation', async () => {
  const { report } = await diffAfter((dir) => {
    edit(dir, 'oodlc/config.yaml', 'defaults:\n', 'probe:\n  conditions: [security.extra-fields]\ndefaults:\n');
    addRoute(dir, "{ method: 'POST', path: '/prefs', handler: async (_c, r) => { const merge = (t: any, s: any): any => { for (const k in s) { if (s[k] && typeof s[k] === 'object') merge(t[k] ??= {}, s[k]); else t[k] = s[k]; } return t; }; merge({}, r.body); return { status: 204 }; } }");
  });
  assert.ok(report.gaps[0].violations.some((v) => v.includes('oodle.prototype-pollution')), JSON.stringify(report.gaps));
  assert.equal(({} as any).oodle_polluted, undefined);
});

// ── The sealed simulation (docs/decisions/0005) ──

test('sealed: an app that reaches the real network directly is a blocking violation, and nothing is sent', async () => {
  const { report } = await diffAfter((dir) =>
    edit(dir, 'src/app.ts', "handler: async () => ({ status: 200, body: { ok: true } })", "handler: async () => { try { await fetch('https://telemetry.example.com/ping'); } catch {} return { status: 200, body: { ok: true } }; }"),
  );
  const b = report.behaviors.find((x) => x.id === 'ops.health')!;
  assert.deepEqual(b.violations, ['[default] constraint oodle.sealed violated: the app reached the real network (telemetry.example.com:443) instead of going through ctx.effects']);
  assert.equal(report.blocking, 1);
});

test('sealed: raw sockets are caught too, and sealed.allow lets a named host through', async () => {
  const dir = copyExample();
  edit(dir, 'src/app.ts', "handler: async () => ({ status: 200, body: { ok: true } })", "handler: async () => { const net = await import('node:net'); await new Promise((done) => { try { const s = net.connect(9, '127.0.0.1'); s.on('error', done); s.on('connect', () => { s.destroy(); done(null); }); } catch (e) { done(e); } }); return { status: 200, body: { ok: true } }; }");
  const sealed = await runProject(dir);
  assert.ok(sealed.observations.find((o) => o.id === 'ops.health')!.violations.some((v) => v.includes('127.0.0.1:9')));
  // Same path, same cached modules: only the config changes, which is read fresh on every run.

  edit(dir, 'oodlc/config.yaml', 'defaults:\n', 'sealed: { allow: [127.0.0.1] }\ndefaults:\n');
  const allowed = await runProject(dir);
  assert.deepEqual(allowed.observations.find((o) => o.id === 'ops.health')!.violations, []);
});

// ── Proposals (docs/decisions/0006) ──

const PROPOSAL = `version: 0
outcomes:
  - id: orders.lookup
    status: proposed
    intent: buy-without-surprises
    statement: A customer can look up an order they placed
    boundary: customer
    trigger: { http: GET /orders/ord_1 }
    expect: { status: 200 }
`;

test('proposed outcome: runs and reports, never blocks; approving it makes it a new outcome that must hold', async () => {
  const head = copyExample();
  writeFileSync(join(head, 'oodlc', 'proposed.yaml'), PROPOSAL);
  const run = await runProject(head);
  const o = run.observations.find((x) => x.id === 'orders.lookup')!;
  assert.equal(o.proposed, true);
  assert.ok(o.failures.length > 0);
  const proposed = diffRuns(await runProject(EXAMPLE), run);
  assert.equal(proposed.blocking, 0);
  assert.equal(proposed.outcomes.find((x) => x.id === 'orders.lookup')!.status, 'proposed');
  assert.ok(lint(run.catalog).warnings.some((w) => w.includes('orders.lookup: proposed outcome')));

  const approved = copyExample();
  writeFileSync(join(approved, 'oodlc', 'proposed.yaml'), PROPOSAL.replace('    status: proposed\n', ''));
  const report = diffRuns(run, await runProject(approved));
  const d = report.outcomes.find((x) => x.id === 'orders.lookup')!;
  assert.equal(d.status, 'failing');
  assert.equal(d.blocking, true);
  assert.equal(d.details[0], 'proposal approved');
});

test('proposed: marking an approved outcome as proposed is a redefinition, so it cannot be used to silence one', async () => {
  const { byId } = await diffAfter((dir) => edit(dir, 'oodlc/checkout.yaml', '  - id: checkout.payment-declined\n', '  - id: checkout.payment-declined\n    status: proposed\n'));
  const d = byId('checkout.payment-declined');
  assert.equal(d.status, 'redefined');
  assert.equal(d.blocking, true);
});

test('proposed constraint: a breach is a notice, not a violation', async () => {
  const { report } = await diffAfter((dir) =>
    writeFileSync(join(dir, 'oodlc', 'draft.yaml'), "version: 0\nconstraints:\n  - id: no-email-ever\n    status: proposed\n    statement: Never send email\n    check: effects.every(e => e.kind !== 'email.sent')\n"),
  );
  assert.equal(report.blocking, 0);
  assert.deepEqual(report.constraints.map((c) => [c.id, c.status, c.blocking]), [['no-email-ever', 'new', false]]);
});

test('a missing stub is named first on the failing outcome, and a failed call is not reported as never made', async () => {
  const dir = copyExample();
  edit(dir, 'oodlc/config.yaml', /    stubs:\n      payment\.capture:\n        result: \{ id: pay_1, status: succeeded \}\n        latency_ms: 120\n/, '    stubs: {}\n');
  const run = await runProject(dir);
  const obs = run.observations.find((o) => o.id === 'checkout.payment-confirmed' && o.condition === 'first_purchase')!;
  assert.match(obs.failures[0], /no stub for external call "payment\.capture"; add one under defaults\.given\.stubs in oodlc\/config\.yaml/);
  assert.ok(obs.failures.includes('effect payment.capture {"amount_cents":6200}: expected 1, but the call failed: no stub for external call "payment.capture"'), obs.failures.join('\n'));
  assert.ok(!obs.failures.some((f) => /payment\.capture.*got 0/.test(f)), obs.failures.join('\n'));
});
