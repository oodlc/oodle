/**
 * Oodle, dogfooded: the CLI is the system under test, presented through the
 * OODLC app contract so the root catalog can declare what Oodle promises.
 *
 * Every route runs the real bin/oodle.js from this checkout. In `oodle check`
 * the base worktree has its own copy of this file, so base runs the base CLI
 * and head runs the head CLI.
 *
 * Responses carry the contract a user relies on (exit codes, error codes,
 * suggestions, outcome statuses), never timings, temp paths or help wording.
 * That keeps runs deterministic, so only a change to the contract shows up
 * in an outcome diff.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext, OodleApp, Request, Response } from '../src/contract.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const EXAMPLE = join(ROOT, 'examples', 'checkout');

/** The child must not inherit the outer run's CI settings unless a condition asks for them. */
const SCRUB = /^(CI|GITHUB_.*|RUNNER_.*|FORCE_COLOR|NO_COLOR|OODLE_.*|COLUMNS)$/;

function oodle(args: string[], env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.test(k)));
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...clean, ...env } });
  return { code: res.status ?? 128, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const parse = (s: string): any => {
  try { return JSON.parse(s); } catch { return undefined; }
};

/** Ids grouped by status, e.g. { broken: ['checkout.payment-confirmed'], held: [...] }. */
function byStatus(items: { id?: string; route?: string; status: string }[] = []): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of items) (out[i.status] ??= []).push((i.id ?? i.route)!);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/** What a script, agent or person can rely on, stripped of anything that varies between runs. */
function contract(r: { code: number; stdout: string; stderr: string }, jsonMode: boolean) {
  const doc = parse(r.stdout);
  const said = `${r.stderr}\n${doc?.error?.hint ?? ''}`;
  const suggests = /Did you mean `?([^`?]+?)`?\?/.exec(said)?.[1];
  // In GitHub Actions, workflow commands (::error, ::warning) are the one thing allowed on stderr in json mode.
  const stderrLines = r.stderr.split('\n').filter((l) => l.trim());
  const body: Record<string, unknown> = {
    exit_code: r.code,
    json_mode: jsonMode,
    stdout_is_json: doc !== undefined,
    stderr_clean: stderrLines.every((l) => l.startsWith('::')),
    annotations: stderrLines.filter((l) => l.startsWith('::')).map((l) => l.slice(2, l.indexOf(' ') > 0 ? l.indexOf(' ') : undefined)).sort(),
  };
  if (suggests) body.suggests = suggests;
  if (doc && typeof doc === 'object') {
    if ('ok' in doc) body.ok = doc.ok;
    if (doc.error) body.error_code = doc.error.code;
    if (doc.summary) {
      const { elapsed_ms, ...summary } = doc.summary;
      body.summary = summary;
    }
    if (Array.isArray(doc.commands)) body.commands = doc.commands.map((c: any) => c.name).join(' ');
    if (Array.isArray(doc.exit_codes)) body.exit_codes = doc.exit_codes.map((e: any) => e.code).join(' ');
    if (Array.isArray(doc.created)) body.created = doc.created.join(' ');
    if (Array.isArray(doc.checks)) body.checks = Object.fromEntries(doc.checks.map((c: any) => [c.name, c.status]));
    if (typeof doc.blocking === 'number') {
      body.blocking = doc.blocking;
      body.outcomes = byStatus(doc.outcomes);
      body.behaviors = byStatus(doc.behaviors.filter((b: any) => b.status !== 'held'));
      body.constraints = byStatus(doc.constraints);
      body.unknown = doc.gaps.map((g: any) => g.route).sort();
      // The reviewer-facing wording of behavior changes, one finding per line.
      body.notes = [...new Set([...doc.outcomes.flatMap((o: any) => o.behavior), ...doc.behaviors.flatMap((b: any) => b.details)].map((l: string) => l.replace(/^\[[^\]]+\] /, '')))].sort().join('\n');
    }
  }
  return body;
}

/** Named edits to a copy of examples/checkout: the changes a real pull request makes. */
const MUTATIONS: Record<string, [file: string, from: string | RegExp, to: string][]> = {
  none: [],
  'refactor-internal': [['src/checkout.ts', "'internal.audit'", "'internal.audit_log'"]],
  'break-response-field': [['src/checkout.ts', '{ order_id: order.id,', '{ orderId: order.id,']],
  'extra-response-field': [['src/checkout.ts', "status: 'confirmed', total_cents }", "status: 'confirmed', total_cents, currency: 'usd' }"]],
  'health-adds-version': [['src/app.ts', 'body: { ok: true }', "body: { ok: true, version: '2' }"]],
  'add-undescribed-route': [['src/app.ts', "    { method: 'POST', path: '/checkout', handler: checkout },", "    { method: 'POST', path: '/checkout', handler: checkout },\n    { method: 'DELETE', path: '/orders/:id', handler: async () => ({ status: 204 }) },"]],
  'remove-constraint': [
    ['oodlc/constraints.yaml', /  - id: receipt-only-for-real-orders[\s\S]*$/, ''],
    ['oodlc/checkout.yaml', ', receipt-only-for-real-orders]', ']'],
  ],
  'reword-outcome': [['oodlc/checkout.yaml', 'gets exactly one receipt', 'receives exactly one receipt']],
  'app-calls-network': [['src/app.ts', 'handler: async () => ({ status: 200, body: { ok: true } })', "handler: async () => { try { await fetch('https://telemetry.example.com/ping'); } catch {} return { status: 200, body: { ok: true } }; }"]],
  'propose-unmet-outcome': [['oodlc/ops.yaml', /$/, '\noutcomes:\n  - id: orders.lookup\n    status: proposed\n    intent: buy-without-surprises\n    statement: A customer can look up an order\n    boundary: customer\n    trigger: { http: GET /orders/ord_1 }\n    expect: { status: 200 }\n']],
};

type Handler = (body: any) => Record<string, unknown>;

export default function createApp(ctx: AppContext): OodleApp {
  const tmp = () => mkdtempSync(join(tmpdir(), 'oodle-dogfood-'));

  /** Runs CLI command lines in order and reports the last. $EXAMPLE, $TMP and $MISSING expand to paths. */
  const invoke: Handler = (body) => {
    const dir = tmp();
    try {
      const steps: string[][] = body?.steps ?? [];
      const expand = (a: string) => a.replace('$EXAMPLE', EXAMPLE).replace('$TMP', dir).replace('$MISSING', join(dir, 'missing'));
      let last = { code: 0, stdout: '', stderr: '' };
      let args: string[] = [];
      for (const step of steps) {
        args = step.map(expand);
        ctx.effects.emit('internal.cli', { args: step });
        last = oodle(args, body?.env ?? {});
      }
      return contract(last, args.includes('--json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** Diffs examples/checkout against a mutated copy, as `oodle diff` would on a pull request. */
  const diff: Handler = (body) => {
    const edits = MUTATIONS[body?.mutation];
    if (!edits) return { error: 'unknown_mutation', mutations: Object.keys(MUTATIONS).join(' ') };
    const dir = tmp();
    try {
      const head = join(dir, 'checkout');
      cpSync(EXAMPLE, head, { recursive: true });
      for (const [file, from, to] of edits) {
        const path = join(head, file);
        const before = readFileSync(path, 'utf8');
        const after = before.replace(from, to);
        if (after === before) return { error: 'mutation_did_not_apply', file };
        writeFileSync(path, after);
      }
      ctx.effects.emit('internal.cli', { args: ['diff', 'examples/checkout', body.mutation, '--json'] });
      return contract(oodle(['diff', EXAMPLE, head, '--json'], body?.env ?? {}), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const table: Record<string, Handler> = { 'POST /invoke': invoke, 'POST /diff': diff };
  return {
    routes: Object.keys(table).map((k) => ({ method: k.split(' ')[0], path: k.split(' ')[1] })),
    async handle(req: Request): Promise<Response> {
      const handler = table[`${req.method} ${req.path}`];
      if (!handler) return { status: 404, body: { error: 'not_found' } };
      const body = handler(req.body);
      return { status: body.error ? 400 : 200, body };
    },
  };
}
