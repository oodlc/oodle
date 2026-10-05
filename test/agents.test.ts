import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { catalogConcerns } from '../src/hooks.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

function oodle(args: string[], opts: { input?: string; cwd?: string; env?: Record<string, string> } = {}) {
  const env = { ...process.env, ...opts.env };
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'OODLE_FORMAT', 'GITHUB_ACTIONS', 'CI', 'NODE_TEST_CONTEXT']) if (!opts.env?.[k]) delete env[k];
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: opts.cwd ?? ROOT, encoding: 'utf8', input: opts.input, env, timeout: 300_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function copyExample(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-agents-')), 'checkout');
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

/** A copy of the example committed to its own git repo, so `oodle check` has a base. */
function repoCopy(): string {
  const repo = mkdtempSync(join(tmpdir(), 'oodle-agents-git-'));
  cpSync(EXAMPLE, repo, { recursive: true });
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('add', '.');
  g('commit', '-qm', 'base');
  return repo;
}

const LOOKUP = `outcomes:
  - id: orders.lookup
    intent: buy-without-surprises
    statement: A customer can look up an order they placed
    boundary: customer
    trigger: { http: GET /orders/ord_1 }
    expect: { status: 200 }
`;

// ── propose ──

test('propose: adds entries as proposals in oodlc/proposed.yaml, whatever the input says', () => {
  const dir = copyExample();
  const r = oodle(['propose', '-', dir, '--json'], { input: `\`\`\`yaml\n${LOOKUP}\`\`\`\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).added, [{ section: 'outcomes', id: 'orders.lookup' }]);
  const file = readFileSync(join(dir, 'oodlc', 'proposed.yaml'), 'utf8');
  assert.match(file, /status: proposed/);
  const run = JSON.parse(oodle(['run', dir, '--json']).stdout);
  assert.equal(run.ok, true, 'a failing proposal does not block');
  assert.equal(run.summary.proposed, 1);
});

test('propose: can only add; an existing id is refused and nothing is written', () => {
  const dir = copyExample();
  const r = oodle(['propose', '-', dir, '--json'], { input: LOOKUP.replace('orders.lookup', 'checkout.payment-confirmed') });
  assert.equal(r.code, 2);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.error.code, 'proposal-exists');
  assert.match(doc.error.problems[0], /checkout\.payment-confirmed already exists in oodlc\/checkout\.yaml/);
  assert.equal(existsSync(join(dir, 'oodlc', 'proposed.yaml')), false);
});

test('propose: a proposal that breaks traceability is rolled back', () => {
  const dir = copyExample();
  const r = oodle(['propose', '-', dir, '--json'], { input: LOOKUP.replace('intent: buy-without-surprises', 'intent: nope') });
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stdout).error.problems.join('\n'), /unknown intent "nope"/);
  assert.equal(existsSync(join(dir, 'oodlc', 'proposed.yaml')), false);
});

test('draft: the prompt carries the rules, this catalog and the brief', () => {
  const dir = copyExample();
  writeFileSync(join(dir, 'brief.md'), 'Customers can see the status of their order.');
  const r = oodle(['draft', join(dir, 'brief.md'), dir]);
  assert.equal(r.code, 0, r.stderr);
  for (const want of ['checkout.payment-confirmed', 'security.no-credentials', '`payment.capture`', 'Customers can see the status of their order.', 'Reply with one YAML document']) {
    assert.ok(r.stdout.includes(want), want);
  }
});

// ── mcp ──

test('mcp: lists propose-only tools and answers a run over stdio', () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: { only: ['checkout.*'] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose', arguments: { yaml: LOOKUP.replace('orders.lookup', 'checkout.empty-cart-rejected') } } },
  ];
  const r = oodle(['mcp', copyExample()], { input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n' });
  assert.equal(r.code, 0, r.stderr);
  const replies = new Map(r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(replies.get(1).result.protocolVersion, '2025-06-18');
  const tools = replies.get(2).result.tools.map((t: any) => t.name);
  assert.deepEqual(tools, ['run', 'check', 'lint', 'catalog', 'explain', 'mutate', 'propose']);
  assert.equal(JSON.parse(replies.get(3).result.content[0].text).ok, true);
  assert.equal(replies.get(4).result.isError, true, 'the propose tool cannot overwrite an outcome');
});

// ── hooks ──

test('hook concerns: changing, removing, approving or silencing an approved entry; proposals are free', () => {
  const base = 'outcomes:\n  - { id: a, statement: A, expect: { status: 200 } }\n  - { id: p, status: proposed, statement: P }\n';
  assert.deepEqual(catalogConcerns(base, base.replace('status: 200', 'status: 201')), ['changes the approved outcome a']);
  assert.deepEqual(catalogConcerns(base, 'outcomes:\n  - { id: p, status: proposed, statement: P }\n'), ['removes the approved outcome a']);
  assert.deepEqual(catalogConcerns(base, base.replace('{ id: a,', '{ id: a, status: proposed,')), ['marks the approved outcome a as proposed, which would stop it blocking']);
  assert.deepEqual(catalogConcerns(base, base.replace('status: proposed, ', '')), ['approves the proposed outcome p']);
  assert.deepEqual(catalogConcerns(base, base.replace('statement: P', 'statement: P2')), []);
  assert.deepEqual(catalogConcerns(base, `${base}  - { id: q, status: proposed, statement: Q }\n`), []);
});

test('hook pre-tool-use: asks before an edit to an approved outcome, stays out of the way otherwise', () => {
  const dir = copyExample();
  const file = join(dir, 'oodlc', 'checkout.yaml');
  const ask = oodle(['hook', 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'latency_ms_max: 2000', new_string: 'latency_ms_max: 9000' } }) });
  const out = JSON.parse(ask.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /changes the approved outcome checkout\.payment-confirmed/);

  const strict = oodle(['hook', 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'latency_ms_max: 2000', new_string: 'latency_ms_max: 9000' } }), env: { OODLE_HOOK_STRICT: '1' } });
  assert.equal(JSON.parse(strict.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const code = oodle(['hook', 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'checkout.ts'), old_string: 'a', new_string: 'b' } }) });
  assert.deepEqual([code.code, code.stdout], [0, '']);

  const sealed = oodle(['hook', 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'oodlc', 'config.yaml'), old_string: 'app: src/app.ts', new_string: 'app: src/app.ts\nsealed: false' } }) });
  assert.match(JSON.parse(sealed.stdout).hookSpecificOutput.permissionDecisionReason, /changes `sealed`/);

  const shell = oodle(['hook', 'pre-tool-use'], { input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: "sed -i '' 's/2000/9000/' oodlc/checkout.yaml" } }) });
  assert.equal(JSON.parse(shell.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('hook session-start: tells the agent how the project is guarded', () => {
  const r = oodle(['hook', 'session-start'], { input: JSON.stringify({ cwd: join(EXAMPLE, 'src') }) });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.match(out.additionalContext, /4 outcomes, 2 constraints, 1 behaviors/);
  assert.equal(oodle(['hook', 'session-start'], { input: JSON.stringify({ cwd: tmpdir() }) }).stdout, '');
});

test('hook stop: blocks while the agent broke an outcome, gives up after three tries, and lets a green change stop', () => {
  const repo = repoCopy();
  const event = (active: boolean) => JSON.stringify({ cwd: repo, session_id: `t-${process.pid}-${Date.now()}`, stop_hook_active: active });
  const green = oodle(['hook', 'stop'], { input: event(false) });
  assert.equal(green.stdout, '', green.stderr);

  const file = join(repo, 'src', 'checkout.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('{ order_id: order.id,', '{ orderId: order.id,'));
  const session = `t-${process.pid}-broken`;
  const run = (active: boolean) => JSON.parse(oodle(['hook', 'stop'], { input: JSON.stringify({ cwd: repo, session_id: session, stop_hook_active: active }) }).stdout);
  const first = run(false);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /outcome checkout\.payment-confirmed broken: \[[^\]]+\] body\.order_id: missing/);
  assert.match(first.reason, /Do not edit, remove or weaken outcomes/);
  assert.equal(run(true).decision, 'block');
  assert.equal(run(true).decision, 'block');
  const gaveUp = run(true);
  assert.equal(gaveUp.decision, undefined);
  assert.match(gaveUp.systemMessage, /still blocking after 3 attempts/);
});

test('hook stop: an outcome change that needs a human is reported to the person, not pushed back on the agent', () => {
  const repo = repoCopy();
  const file = join(repo, 'src', 'checkout.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace("status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'usd' }"));
  const r = JSON.parse(oodle(['hook', 'stop'], { input: JSON.stringify({ cwd: repo, session_id: `t-${process.pid}-human` }) }).stdout);
  assert.equal(r.decision, undefined);
  assert.match(r.systemMessage, /needs your approval before merge: outcome checkout\.payment-confirmed changed/);
});
