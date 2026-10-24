/**
 * `oodle intent new|list|review|approve|merge`, and what merged intents add to a build's checks.
 *
 * Only merged intents count: the checks come from the intents on the base ref
 * (`intents.base`, default main), read with git, never from the working tree.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, readCompiled, type Vocabulary } from '@oodle/compile';
import { cluster, diffRuns } from '@oodle/diff';
import { raiseGaps, readGaps } from '@oodle/gaps';
import { build, claudeAgent } from '@oodle/generator';
import type { Scenario, ScenarioResult } from '@oodle/sim';
import {
  applyChanges,
  changedEntities,
  currentApproval,
  type Intent,
  intentContentHash,
  loadSpec,
  parseIntent,
  readIntents,
  SPEC_DIR,
  specHash,
  writeChanges,
  writeIntent,
} from '@oodle/spec';
import { type Approval, commit, isRepo, listAt, noteSuperseded, repoPath, show, userEmail } from '@oodle/sync';
import { type Finding, type IntentChecks, verify } from '@oodle/verify';
import { CliError, type Ctx, done, EXIT, NeedsPerson } from '../context.ts';

// ── merged intents and what they add to a build ─────────────────────────────

/** Intents merged on the base ref. Outside git, there are none. */
export function mergedIntents(ctx: Ctx): Intent[] {
  if (!isRepo(ctx.root)) return [];
  const base = ctx.config.intents.base;
  const dir = repoPath(ctx.root, `${SPEC_DIR}/intents`);
  return listAt(ctx.root, base, dir)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => {
      const text = show(ctx.root, base, f);
      if (!text) return [];
      try {
        return [parseIntent(text, `${base}:${f}`)];
      } catch {
        return [];
      }
    })
    .filter((i) => i.status === 'merged');
}

interface PassingBuild {
  id: string;
  app: string;
  startedAt: string;
}

/** Builds that passed verify, newest first. */
function passingBuilds(ctx: Ctx): PassingBuild[] {
  const dir = join(ctx.root, '.oodle', 'builds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'manifest.json')))
    .map((d) => ({ d, m: JSON.parse(readFileSync(join(dir, d, 'manifest.json'), 'utf8')) as { status: string; verified?: boolean; startedAt: string } }))
    .filter(({ m }) => m.status === 'built' && m.verified === true)
    .map(({ d, m }) => ({ id: d, app: join(dir, d, 'app'), startedAt: m.startedAt }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Merged intents whose first build hasn't passed yet: their rules_out and done_when still apply. */
export function pendingIntents(ctx: Ctx): Intent[] {
  const last = passingBuilds(ctx)[0];
  return mergedIntents(ctx).filter((i) => !last || !i.merged_at || i.merged_at > last.startedAt);
}

const WORDS: Record<string, string> = {
  new_dependencies: 'new dependencies in package.json',
  new_outbound_hosts: 'requests to any outside host the last passing build did not call',
  new_routes: 'new top-level routes',
};

export async function ruledOutWords(ctx: Ctx): Promise<string[]> {
  return [...new Set(pendingIntents(ctx).flatMap((i) => i.rules_out.map((r) => `${WORDS[r] ?? r} (intent ${i.id})`)))];
}

const TEMPLATE_DEPS = new Set(['hono', '@oodle/runtime']);

/** Top-level route segments an app declares: `app.get('/walks/:id', …)` is `walks`. */
function routesOf(app: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/oodle\.driver/.test(name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\.(?:get|post|put|patch|delete|all|on)\(\s*['"`](\/[^'"`]*)['"`]/g))
          out.add((m[1] as string).split('/')[1] ?? '');
      }
    }
  };
  walk(join(app, 'src'));
  return out;
}

export async function intentChecks(ctx: Ctx, app: string): Promise<IntentChecks | undefined> {
  const pending = pendingIntents(ctx);
  if (!pending.length) return undefined;
  const findings: Finding[] = [];
  const previous = passingBuilds(ctx).find((b) => b.app !== app);
  const ruled = new Set(pending.flatMap((i) => i.rules_out));
  const who = (r: string) =>
    pending
      .filter((i) => i.rules_out.includes(r as never))
      .map((i) => i.id)
      .join(', ');

  if (ruled.has('new_dependencies')) {
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      if (!TEMPLATE_DEPS.has(dep))
        findings.push({ stage: 'intent', blocking: true, subject: who('new_dependencies'), message: `a new dependency, ${dep}, which the intent rules out` });
  }
  if (ruled.has('new_routes') && previous) {
    const before = routesOf(previous.app);
    for (const r of routesOf(app))
      if (!before.has(r))
        findings.push({ stage: 'intent', blocking: true, subject: who('new_routes'), message: `a new top-level route, /${r}, which the intent rules out` });
  }
  let allowedHosts: string[] | undefined;
  if (ruled.has('new_outbound_hosts')) {
    const saved = previous ? join(previous.app, '..', 'observations.json') : undefined;
    const results = saved && existsSync(saved) ? (JSON.parse(readFileSync(saved, 'utf8')) as ScenarioResult[]) : [];
    allowedHosts = [...new Set(results.flatMap((r) => r.observations.flatMap((o) => o.outbound.map((x) => x.host))))];
  }
  const journeys = [...new Set(pending.flatMap((i) => [...i.done_when.journeys, ...i.keeps.journeys]))];
  return { findings, journeys, ...(allowedHosts ? { allowedHosts } : {}) };
}

// ── sync ────────────────────────────────────────────────────────────────────

export async function intentsForSync(ctx: Ctx) {
  return readIntents(ctx.root).map(({ intent }) => ({
    id: intent.id,
    content_hash: intentContentHash(intent),
    body: intent as unknown as Record<string, unknown>,
  }));
}

/** A review from the inbox: recorded on the intent if it is still about the same content. */
export async function onApproval(ctx: Ctx, a: Approval): Promise<void> {
  const found = readIntents(ctx.root).find((x) => x.intent.id === a.intent_id);
  if (!found) return;
  const { file, intent } = found;
  if (intentContentHash(intent) !== a.content_hash) {
    ctx.print(`  ! a review of ${intent.id} by ${a.by} is for an older version of it; it doesn't count`);
    return;
  }
  const by = a.by.startsWith('person:') ? a.by : `person:${a.by}`;
  if (intent.approvals.some((x) => x.by === by && x.content_hash === a.content_hash && x.decision === a.decision)) return;
  const next: Intent = {
    ...intent,
    status: intent.status === 'merged' ? 'merged' : a.decision === 'approve' ? 'approved' : 'rejected',
    approvals: [
      ...intent.approvals,
      { by, at: a.at ?? new Date().toISOString(), via: 'inbox', decision: a.decision, content_hash: a.content_hash, ...(a.note ? { note: a.note } : {}) },
    ],
  };
  writeIntent(ctx.root, file, next);
  commit(ctx.root, [`${SPEC_DIR}/intents`], `oodle: ${a.decision === 'approve' ? 'approval' : 'rejection'} of ${intent.id} from the inbox (${by})`);
  ctx.print(`  ✓ ${intent.id} ${a.decision === 'approve' ? 'approved' : 'rejected'} by ${by} in the inbox`);
}

// ── commands ────────────────────────────────────────────────────────────────

function find(ctx: Ctx, id: string) {
  const found = readIntents(ctx.root).find((x) => x.intent.id === id || x.file === id || x.file === `${id}.yaml`);
  if (!found) throw new CliError(`No intent ${id} in oodle/intents/.`, EXIT.usage);
  return found;
}

export function intentNew(ctx: Ctx, slug: string, opts: { title?: string }): number {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const file = `${new Date().toISOString().slice(0, 7)}-${clean}.yaml`;
  if (existsSync(join(ctx.root, SPEC_DIR, 'intents', file))) throw new CliError(`oodle/intents/${file} already exists.`, EXIT.usage);
  const intent: Intent = {
    id: `i_${clean.replace(/-/g, '_')}`,
    title: opts.title ?? clean.replace(/-/g, ' '),
    status: 'draft',
    why: '',
    changes: [],
    keeps: { journeys: [], constraints: [] },
    rules_out: ['new_dependencies', 'new_outbound_hosts', 'new_routes'],
    done_when: { journeys: [], evals: [] },
    approvals: [],
  };
  const path = writeIntent(ctx.root, file, intent);
  ctx.print(`Wrote oodle/intents/${file}. Say why, list the changes, then \`oodle intent review ${intent.id}\`.`);
  return done(ctx, { id: intent.id, file: path });
}

export function intentList(ctx: Ctx): number {
  const merged = new Set(mergedIntents(ctx).map((i) => i.id));
  const gaps = readGaps(ctx.root);
  const rows = readIntents(ctx.root).map(({ file, intent }) => {
    const approval = currentApproval(intent);
    const stale = intent.approvals.length > 0 && !approval;
    const open = gaps.filter((g) => g.intent_id === intent.id && g.status === 'open').length;
    return {
      id: intent.id,
      file,
      title: intent.title,
      status: intent.status,
      merged_on_base: merged.has(intent.id),
      approved_by: approval?.decision === 'approve' ? approval.by : null,
      stale_approval: stale,
      open_gaps: open,
    };
  });
  for (const r of rows)
    ctx.print(
      `${r.id}  ${r.status}${r.merged_on_base ? ' (on base)' : ''}  ${r.title}${r.approved_by ? `  approved by ${r.approved_by}` : ''}${r.stale_approval ? '  (approval is stale: the intent changed)' : ''}${r.open_gaps ? `  ${r.open_gaps} open gaps` : ''}`,
    );
  if (!rows.length) ctx.print('No intents. `oodle intent new <name>` starts one.');
  return done(ctx, { intents: rows });
}

/**
 * Applies the changes to a scratch copy of the spec, builds it twice (or takes two builds given
 * with --a and --b), and runs the gaps check on the journeys and exploration the change reaches.
 * The gaps are raised for the intent, in the project.
 */
export async function intentReview(ctx: Ctx, id: string, opts: { a?: string; b?: string }): Promise<number> {
  const { file, intent } = find(ctx, id);
  if (intent.status === 'merged') throw new CliError(`${intent.id} is already merged.`, EXIT.usage);
  if (!intent.changes.length) throw new CliError(`${intent.id} has no changes yet.`, EXIT.usage);
  const { spec: before } = loadSpec(ctx.root);
  applyChanges(before, intent.changes);

  const scratch = mkdtempSync(join(tmpdir(), 'oodle-intent-'));
  cpSync(join(ctx.root, SPEC_DIR), join(scratch, SPEC_DIR), {
    recursive: true,
    filter: (s) => !s.includes(`${SPEC_DIR}/gaps`) && !s.includes(`${SPEC_DIR}/intents`),
  });
  writeChanges(scratch, intent.changes, `from intent ${intent.id}`);
  ctx.print(`Reviewing ${intent.id}: compiling the changed spec…`);
  await compile(scratch, { model: ctx.model(), cap: ctx.config.explore.cap });
  const c = readCompiled(scratch);
  const { spec } = loadSpec(scratch);
  const vocab = c.vocabulary as Vocabulary;

  const entities = changedEntities(spec, intent.changes);
  const beforeJourneys = new Map(before.journeys.map((j) => [j.id, JSON.stringify(j)]));
  const reaches = (s: Scenario) => s.steps.some((st) => (st.do ? entities.includes(vocab.actions.find((a) => a.id === st.do)?.entity ?? '') : false));
  const scenarios = [
    ...c.journeys
      .filter((j) => beforeJourneys.get(j.journey) !== JSON.stringify(spec.journeys.find((x) => x.id === j.journey)) || reaches(j.scenario as Scenario))
      .map((j) => j.scenario as Scenario),
    ...((c.explore?.scenarios ?? []) as Scenario[]).filter(reaches),
  ];

  const sides: { label: string; results: ScenarioResult[] }[] = [];
  if (opts.a && opts.b) {
    for (const dir of [opts.a, opts.b])
      sides.push({ label: `dir:${dir}`, results: (await verify(dir, { ...c, journeys: c.journeys, explore: c.explore }, { typecheck: false })).results });
  } else {
    for (const seed of [1, 2]) {
      const r = await build(scratch, {
        seed,
        vocab,
        runner: claudeAgent({ model: ctx.config.model }),
        model: ctx.model(),
        dir: join(ctx.root, '.oodle', 'builds'),
      });
      if (r.manifest.status !== 'built') throw new CliError(`A review build didn't build: ${r.manifest.problems.join('; ') || r.manifest.blocked}`);
      sides.push({ label: `build:${r.buildId}`, results: (await verify(r.app, c, { typecheck: false })).results });
    }
  }
  const ids = new Set(scenarios.map((s) => s.id));
  const [A, B] = sides.map((s) => ({ ...s, results: s.results.filter((r) => ids.has(r.scenario)) })) as [(typeof sides)[0], (typeof sides)[0]];
  const signatures = cluster(
    diffRuns({ scenarios, entities: Object.keys(spec.domain), entityOf: (x) => vocab.actions.find((a) => a.id === x)?.entity }, A.results, B.results),
  );
  const raised = await raiseGaps(ctx.root, signatures, {
    spec,
    vocab,
    scenarios,
    specHash: specHash(spec),
    foundIn: [A.label, B.label],
    config: ctx.config,
    model: ctx.model(),
    intentId: intent.id,
  });
  noteSuperseded(ctx.root, raised.superseded);

  writeIntent(ctx.root, file, { ...intent, status: intent.status === 'draft' || intent.status === 'rejected' ? 'in_review' : intent.status });
  commit(ctx.root, [SPEC_DIR], `oodle: review ${intent.id}`);
  const open = readGaps(ctx.root).filter((g) => g.intent_id === intent.id && g.status === 'open');
  ctx.print(
    `${intent.id} is in review over ${scenarios.length} scenarios. ${open.length ? `${open.length} question${open.length === 1 ? '' : 's'} to answer before it can be approved:` : 'The two builds agree on everything it reaches.'}`,
  );
  for (const g of open) ctx.print(`  ${g.id} [${g.route}] ${g.question}`);
  return done(ctx, {
    id: intent.id,
    status: 'in_review',
    scenarios: scenarios.length,
    open: open.map((g) => ({ id: g.id, route: g.route, question: g.question })),
  });
}

export function intentApprove(ctx: Ctx, id: string, opts: { reject?: boolean; note?: string }): number {
  const { file, intent } = find(ctx, id);
  if (!ctx.tty) throw new NeedsPerson(`approving ${intent.id}`, ctx.config);
  if (intent.status === 'merged') throw new CliError(`${intent.id} is already merged.`, EXIT.usage);
  const open = readGaps(ctx.root).filter((g) => g.intent_id === intent.id && g.status === 'open');
  if (!opts.reject && open.length)
    throw new CliError(
      `${intent.id} still has ${open.length} open question${open.length === 1 ? '' : 's'}: ${open.map((g) => g.id).join(', ')}. Answer them first.`,
    );
  if (!opts.reject && intent.status === 'draft') throw new CliError(`${intent.id} hasn't been reviewed: run \`oodle intent review ${intent.id}\` first.`);
  const by = `person:${userEmail(ctx.root) ?? 'unknown'}`;
  const decision = opts.reject ? 'reject' : 'approve';
  writeIntent(ctx.root, file, {
    ...intent,
    status: opts.reject ? 'rejected' : 'approved',
    approvals: [
      ...intent.approvals,
      { by, at: new Date().toISOString(), via: 'cli', decision, content_hash: intentContentHash(intent), ...(opts.note ? { note: opts.note } : {}) },
    ],
  });
  commit(ctx.root, [`${SPEC_DIR}/intents`], `oodle: ${opts.reject ? 'reject' : 'approve'} ${intent.id} (${by})`);
  ctx.print(`${intent.id} ${opts.reject ? 'rejected' : 'approved'} by ${by}.`);
  return done(ctx, { id: intent.id, status: opts.reject ? 'rejected' : 'approved', by });
}

/** Writes an approved intent's changes into the spec and marks it merged, in one commit. */
export function intentMerge(ctx: Ctx, id: string): number {
  const { file, intent } = find(ctx, id);
  const approval = currentApproval(intent);
  if (intent.status === 'merged') throw new CliError(`${intent.id} is already merged.`, EXIT.usage);
  if (!approval || approval.decision !== 'approve') {
    throw new CliError(
      intent.approvals.length
        ? `${intent.id}'s approval is stale or it was rejected: the intent changed after it was reviewed. Review and approve it again.`
        : `${intent.id} isn't approved yet.`,
    );
  }
  const open = readGaps(ctx.root).filter((g) => g.intent_id === intent.id && g.status === 'open');
  if (open.length) throw new CliError(`${intent.id} still has open questions: ${open.map((g) => g.id).join(', ')}.`);
  const written = writeChanges(ctx.root, intent.changes, `from intent ${intent.id}, approved by ${approval.by}`);
  writeIntent(ctx.root, file, { ...intent, status: 'merged', merged_at: new Date().toISOString() });
  const sha = commit(ctx.root, [SPEC_DIR], `oodle: merge ${intent.id} (approved by ${approval.by})`);
  ctx.print(
    `Merged ${intent.id}: ${written.map((w) => w.slice(ctx.root.length + 1)).join(', ')}${sha ? ` in ${sha.slice(0, 7)}` : ''}. Next: \`oodle build\`.`,
  );
  return done(ctx, { id: intent.id, status: 'merged', changed: written, sha: sha ?? null });
}
