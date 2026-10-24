/**
 * The local loop: build, gaps, answer, status, export.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readCompiled, type Vocabulary } from '@oodle/compile';
import { cluster, diffRuns } from '@oodle/diff';
import { type Answer, agentAnswer, type Gap, raiseGaps, readGaps, writeGap } from '@oodle/gaps';
import { type BuildResult, build, claudeAgent, type Manifest, saveManifest, sortProposals } from '@oodle/generator';
import type { Scenario, ScenarioResult } from '@oodle/sim';
import { type Decision, loadSpec, sha256, specHash, writeDecisions } from '@oodle/spec';
import { AnswerRefused, applyAnswer, commit, noteSuperseded, recordApplied, uncommittedSpec, userEmail } from '@oodle/sync';
import { stepProblems, summarize, type VerifyReport, verify } from '@oodle/verify';
import { buildsDir, resolveBuild } from '../builds.ts';
import { CliError, type Ctx, done, EXIT, NeedsPerson } from '../context.ts';
import { compiled as ensureCompiled, saveReport } from './basics.ts';
import { intentChecks, ruledOutWords } from './intents.ts';

// ── build ───────────────────────────────────────────────────────────────────

export async function buildCommand(ctx: Ctx, opts: { seed?: string; from?: string; force?: boolean }): Promise<number> {
  const result = await buildAndVerify(ctx, { seed: opts.seed ? Number(opts.seed) : 1, from: opts.from, force: opts.force });
  return done(
    ctx,
    {
      buildId: result.build.buildId,
      status: result.build.manifest.status,
      reused: result.build.reused,
      verified: result.report?.passed ?? null,
      problems: result.build.manifest.problems,
      decisions_added: result.added,
    },
    result.ok ? EXIT.ok : EXIT.failed,
  );
}

export interface BuiltAndVerified {
  build: BuildResult;
  report?: VerifyReport;
  added: string[];
  ok: boolean;
}

/** One build, verified; new decisions join the spec only if it passes. A moved decision becomes a gap and blocks. */
/**
 * `adopt: false` keeps a passing build's new decisions out of the spec: the gaps check builds twice
 * from the same spec, so neither build may change it before the other has run.
 */
export async function buildAndVerify(
  ctx: Ctx,
  opts: { seed: number; from?: string; force?: boolean; recordLatest?: boolean; adopt?: boolean },
): Promise<BuiltAndVerified> {
  const c = await ensureCompiled(ctx);
  const vocab = c.vocabulary as Vocabulary;
  ctx.print(`Building (seed ${opts.seed})…`);
  const result = await build(ctx.root, {
    seed: opts.seed,
    from: opts.from,
    force: opts.force,
    vocab,
    runner: claudeAgent({ model: ctx.config.model }),
    model: ctx.model(),
    ruledOut: await ruledOutWords(ctx),
  });
  const m = result.manifest;
  if (opts.recordLatest !== false) writeFileSync(join(buildsDir(ctx), 'latest'), `${result.buildId}\n`);
  if (result.reused) ctx.print(`Reusing build ${result.buildId}, which passed for this spec.`);
  else ctx.print(`Build ${result.buildId}: ${m.status} in ${m.seconds}s (agent: ${m.agent.turns} turns, $${m.agent.costUsd.toFixed(2)})`);
  for (const p of m.problems) ctx.print(`  ✗ ${p}`);
  if (m.blocked) ctx.print(`  The agent stopped: ${m.blocked}`);

  const moved = m.proposedDecisions.moved;
  if (moved.length) await raiseMoved(ctx, result.buildId, moved);
  if (m.status !== 'built') return { build: result, added: [], ok: false };
  if (result.reused) return { build: result, added: [], ok: true };

  const report = await verify(result.app, c, { intents: await intentChecks(ctx, result.app) });
  saveReport(ctx, { dir: result.app, id: result.buildId }, report);
  ctx.print(summarize(report));
  m.verified = report.passed;
  saveManifest(result);
  if (!report.passed) return { build: result, report, added: [], ok: false };

  const fresh = m.proposedDecisions.fresh;
  if (fresh.length && opts.adopt !== false) {
    const loaded = loadSpec(ctx.root);
    const known = new Set(loaded.spec.decisions.map((d) => d.id));
    const add = fresh.filter((d) => !known.has(d.id));
    writeDecisions(loaded, [...loaded.spec.decisions, ...add]);
    ctx.print(`Added ${add.length} decision${add.length === 1 ? '' : 's'} the build made to oodle/decisions.yaml.`);
    return { build: result, report, added: add.map((d) => d.text), ok: true };
  }
  return { build: result, report, added: [], ok: true };
}

/** A proposal that would change a pinned decision is a question for a person, never a silent change. */
async function raiseMoved(ctx: Ctx, buildId: string, moved: { proposal: { text: string; about: string[] }; pinned: Decision; reason: string }[]) {
  const { spec } = loadSpec(ctx.root);
  for (const m of moved) {
    const id = `g_${sha256(`${m.pinned.id}\n${m.proposal.text}`).slice(0, 8)}`;
    const existing = readGaps(ctx.root).find((g) => g.id === id);
    if (existing && existing.status !== 'open') continue;
    const gap: Gap = {
      id,
      status: 'open',
      kind: 'decision_moved',
      tier: 'decided',
      tier_reason: 'it would move a pinned decision, so a person decides',
      route: 'human',
      spec_hash: specHash(spec),
      found_in: [`build:${buildId}`],
      about: m.pinned.about.length ? m.pinned.about : m.proposal.about,
      question: `A new build would change a pinned decision: "${m.pinned.text}" would become "${m.proposal.text}". Keep the pinned one?`,
      evidence: {
        scenario: `build/${buildId}`,
        scenario_text: m.reason,
        a: { summary: 'Pinned', sample: [m.pinned.text] },
        b: { summary: 'Proposed', sample: [m.proposal.text] },
      },
      options: [
        { id: 'a', label: 'Keep it', becomes: { decision: m.pinned.text, replaces: m.pinned.text } },
        { id: 'b', label: 'Change it', becomes: { decision: m.proposal.text, replaces: m.pinned.text } },
      ],
      answer: null,
      answered_by: null,
      answered_at: null,
      applied_in: null,
    };
    writeGap(ctx.root, gap);
    ctx.print(`  ? ${id}: ${gap.question}`);
  }
}

// ── gaps ────────────────────────────────────────────────────────────────────

export async function gapsCommand(ctx: Ctx, opts: { journeysOnly?: boolean; scope?: string; a?: string; b?: string }): Promise<number> {
  const c = await ensureCompiled(ctx);
  const { spec } = loadSpec(ctx.root);
  const intentId = opts.scope?.startsWith('intent:') ? opts.scope.slice('intent:'.length) : undefined;
  const scenarios = [...c.journeys.map((j) => j.scenario), ...(opts.journeysOnly ? [] : (c.explore?.scenarios ?? []))] as Scenario[];

  let sides: { label: string; results: ScenarioResult[] }[];
  const manifests: Manifest[] = [];
  if (opts.a && opts.b) {
    sides = [];
    for (const dir of [opts.a, opts.b]) {
      const report = await verify(resolve(dir), c, { typecheck: false, explore: !opts.journeysOnly });
      sides.push({ label: `dir:${dir}`, results: report.results });
    }
  } else {
    sides = [];
    for (const seed of [1, 2]) {
      const r = await buildAndVerify(ctx, { seed, recordLatest: seed === 1, adopt: false });
      manifests.push(r.build.manifest);
      if (r.build.manifest.status !== 'built')
        throw new CliError(`Build ${r.build.buildId} didn't build (${r.build.manifest.status}); fix that before looking for gaps.`);
      // A build that breaks the spec would show up as differences; gaps are about what the spec leaves open.
      if (r.report && !r.report.passed)
        throw new CliError(
          `Build ${r.build.buildId} fails verify, so its differences aren't gaps. See .oodle/builds/${r.build.buildId}/verify.json, then build again (--force).`,
        );
      const saved = join(r.build.dir, 'observations.json');
      const results =
        r.report?.results ??
        (existsSync(saved) ? (JSON.parse(readFileSync(saved, 'utf8')) as ScenarioResult[]) : (await verify(r.build.app, c, { typecheck: false })).results);
      sides.push({ label: `build:${r.build.buildId}`, results });
    }
  }
  // The gaps check runs journeys and exploration; verify's own check scenarios aren't part of it.
  const ids = new Set(scenarios.map((s) => s.id));
  const [A, B] = sides.map((s) => ({ ...s, results: s.results.filter((r) => ids.has(r.scenario)) })) as [(typeof sides)[0], (typeof sides)[0]];
  const vocab = c.vocabulary as Vocabulary;
  const entityOf = (action: string) => vocab.actions.find((x) => x.id === action)?.entity;
  const signatures = cluster(diffRuns({ scenarios, entities: Object.keys(spec.domain), entityOf }, A.results, B.results));

  // A gap where one build breaks a journey or a constraint and the other doesn't is declared-tier.
  const contradictions = new Map<string, string>();
  for (const sig of signatures) {
    const s = scenarios.find((x) => x.id === sig.evidence.scenario);
    if (!s) continue;
    const at = (side: typeof A) => side.results.find((r) => r.scenario === s.id)?.observations[sig.evidence.step];
    const [oa, ob] = [at(A), at(B)];
    if (!oa || !ob) continue;
    const [pa, pb] = [stepProblems(c, s, sig.evidence.step, oa), stepProblems(c, s, sig.evidence.step, ob)];
    if (pa.length !== pb.length) contradictions.set(sig.id, `build ${pa.length ? 'A' : 'B'}: ${(pa.length ? pa : pb)[0]}`);
  }

  const raised = await raiseGaps(ctx.root, signatures, {
    spec,
    vocab,
    scenarios,
    specHash: specHash(spec),
    foundIn: [A.label, B.label],
    config: ctx.config,
    model: ctx.model(),
    contradictions,
    intentId,
  });
  noteSuperseded(ctx.root, raised.superseded);
  const adopted = await adoptAgreed(ctx, manifests);
  if (adopted.length) ctx.print(`Both builds made ${adopted.length} of the same decision${adopted.length === 1 ? '' : 's'}; added to oodle/decisions.yaml.`);
  const open = readGaps(ctx.root).filter((g) => g.status === 'open' && (intentId ? g.intent_id === intentId : true));
  const state = statePath(ctx);
  if (!open.length) {
    writeFileSync(state, `${JSON.stringify({ last_agreeing_spec: specHash(spec), at: new Date().toISOString() }, null, 2)}\n`);
    ctx.print(
      `Builds agree${raised.settled.length ? ` (${raised.settled.length} difference${raised.settled.length === 1 ? '' : 's'} already answered)` : ''}.`,
    );
    return done(ctx, { agree: true, open: [], settled: raised.settled.map((g) => g.id), superseded: raised.superseded });
  }
  ctx.print(`${open.length} open gap${open.length === 1 ? '' : 's'}:`);
  for (const g of open) ctx.print(`  ${g.id} [${g.kind}, ${g.tier}, ${g.route}] ${g.question}`);
  ctx.print(open.some((g) => g.route === 'agent') ? 'Settle the agent-routed ones with `oodle answer --auto`.' : '');
  return done(ctx, { agree: false, open: open.map(brief), settled: raised.settled.map((g) => g.id), superseded: raised.superseded }, EXIT.failed);
}

/**
 * Decisions both builds proposed on their own are what the spec implies, not gaps: they join the
 * spec, in build A's words. The rest stay out; where they matter, they showed up as gaps.
 */
async function adoptAgreed(ctx: Ctx, manifests: Manifest[]): Promise<string[]> {
  const [a, b] = manifests;
  if (!a || !b) return [];
  const sorted = await sortProposals(
    b.proposedDecisions.fresh.map((d) => ({ text: d.text, about: d.about })),
    a.proposedDecisions.fresh,
    { buildId: b.buildId, model: ctx.model() },
  );
  const loaded = loadSpec(ctx.root);
  const known = new Set(loaded.spec.decisions.map((d) => d.id));
  const agreed = [...new Set(sorted.duplicates.map((d) => d.of))]
    .map((id) => a.proposedDecisions.fresh.find((d) => d.id === id))
    .filter((d): d is Decision => !!d && !known.has(d.id));
  if (agreed.length) writeDecisions(loaded, [...loaded.spec.decisions, ...agreed]);
  return agreed.map((d) => d.text);
}

const statePath = (ctx: Ctx) => ctx.work('gaps-state.json');
const brief = (g: Gap) => ({
  id: g.id,
  kind: g.kind,
  tier: g.tier,
  route: g.route,
  question: g.question,
  options: g.options.map((o) => ({ id: o.id, label: o.label })),
});

// ── answer ──────────────────────────────────────────────────────────────────

export async function answerCommand(
  ctx: Ctx,
  gapId: string | undefined,
  opts: { option?: string; text?: string; target?: string; dontCare?: boolean; dismiss?: boolean; auto?: boolean; reason?: string; apply?: boolean },
): Promise<number> {
  const blocking = uncommittedSpec(ctx.root);
  if (blocking.length)
    throw new CliError(`Commit or undo your changes under oodle/ first; answers aren't applied over uncommitted edits:\n${blocking.join('\n')}`);
  commit(ctx.root, ['oodle/gaps'], 'oodle: gaps found');
  const { spec } = loadSpec(ctx.root);
  const vocab = readCompiled(ctx.root).vocabulary as Vocabulary;

  if (opts.auto) {
    const open = readGaps(ctx.root).filter((g) => g.status === 'open');
    const mine = open.filter((g) => g.route === 'agent');
    const shas: { gap: string; sha: string }[] = [];
    const settled: { id: string; option?: string; reason?: string }[] = [];
    const refused: { id: string; why: string }[] = [];
    for (const g of mine) {
      const answer = await agentAnswer(g, { spec: loadSpec(ctx.root).spec, vocab }, ctx.model());
      try {
        const out = applyAnswer(ctx.root, g.id, answer, `agent:${ctx.model().name}@local`);
        if (out.sha) shas.push({ gap: g.id, sha: out.sha });
        settled.push({ id: g.id, option: answer.option, reason: answer.reason });
        ctx.print(`  ✓ ${g.id}: ${g.options.find((o) => o.id === answer.option)?.label} (${answer.reason})`);
      } catch (e) {
        if (!(e instanceof AnswerRefused)) throw e;
        // The option the agent chose writes something only a person may; leave the gap to people.
        refused.push({ id: g.id, why: e.message });
        ctx.print(`  ? ${g.id}: ${e.message}`);
      }
    }
    recordApplied(ctx.root, shas);
    const people = [...open.filter((g) => g.route === 'human'), ...mine.filter((g) => refused.some((r) => r.id === g.id))];
    if (people.length) {
      for (const g of people) ctx.print(`  ? ${g.id} needs a person: ${g.question}`);
      const err = new NeedsPerson(`${people.length} gap${people.length === 1 ? '' : 's'} routed to people (${people.map((g) => g.id).join(', ')})`, ctx.config);
      ctx.print(err.message);
      return done(ctx, { settled, needs_person: people.map(brief), inbox: ctx.config.remote?.url ?? null }, EXIT.needsPerson);
    }
    ctx.print(settled.length ? `Settled ${settled.length} gap${settled.length === 1 ? '' : 's'}.` : 'No gaps routed to agents.');
    return done(ctx, { settled, needs_person: [] });
  }

  if (!gapId) throw new CliError('Which gap? `oodle answer <gapId> --option a`, or `oodle answer --auto`.', EXIT.usage);
  const gap = readGaps(ctx.root).find((g) => g.id === gapId);
  if (!gap) throw new CliError(`No gap ${gapId}.`, EXIT.usage);

  let answer: Answer | undefined;
  if (opts.option) answer = { option: opts.option };
  else if (opts.text) answer = { text: opts.text, target: (opts.target ?? 'decision') as Answer['target'] };
  else if (opts.dontCare) answer = { dont_care: true };
  else if (opts.dismiss) answer = { dismiss: true };
  if (opts.reason && answer) answer.reason = opts.reason;

  let who: string;
  if (ctx.tty) {
    who = `person:${userEmail(ctx.root) ?? 'unknown'}`;
    answer ??= await ask(gap);
  } else {
    // No one at the keyboard: an agent. Allowed only where the route says so.
    if (gap.route === 'human') throw new NeedsPerson(`${gap.id} is routed to people ("${gap.question}")`, ctx.config);
    if (!answer) throw new CliError('Say which: --option, --text, --dont-care or --dismiss.', EXIT.usage);
    if (!answer.reason) throw new CliError('An agent says why: add --reason "<one sentence>".', EXIT.usage);
    who = `agent:${process.env.OODLE_AGENT_NAME ?? 'local'}@local`;
  }
  try {
    const out = applyAnswer(ctx.root, gap.id, answer, who);
    if (out.sha) recordApplied(ctx.root, [{ gap: gap.id, sha: out.sha }]);
    ctx.print(`Applied ${gap.id} (${who}): ${out.changed.join(', ')}`);
    return done(ctx, { gap: gap.id, answered_by: who, changed: out.changed, sha: out.sha ?? null });
  } catch (e) {
    if (e instanceof AnswerRefused) throw new CliError(e.message);
    throw e;
  }
}

/** Asks a person at the keyboard. */
async function ask(gap: Gap): Promise<Answer> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      `\n${gap.question}\n  scenario: ${gap.evidence.scenario_text ?? gap.evidence.scenario}\n  A: ${gap.evidence.a.summary}\n  B: ${gap.evidence.b.summary}\n\n`,
    );
    for (const o of gap.options) process.stdout.write(`  ${o.id}) ${o.label}\n`);
    process.stdout.write('  t) write a rule instead\n  x) not a real difference\n');
    const choice = (await rl.question('> ')).trim();
    if (choice === 'x') return { dismiss: true };
    if (choice === 't') {
      const text = (await rl.question('The rule, in plain words: ')).trim();
      const target = (await rl.question('Is it a decision (d), a domain rule (r) or a constraint (c)? ')).trim();
      return { text, target: target === 'r' ? 'domain_rule' : target === 'c' ? 'constraint' : 'decision' };
    }
    if (choice === 'dont_care') return { dont_care: true };
    if (!gap.options.some((o) => o.id === choice)) throw new CliError(`No option "${choice}".`, EXIT.usage);
    return { option: choice };
  } finally {
    rl.close();
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export function statusCommand(ctx: Ctx): number {
  const gaps = readGaps(ctx.root);
  const open = gaps.filter((g) => g.status === 'open');
  const c = readCompiled(ctx.root);
  const unchecked = c.checks
    .filter((k) => k.check.kind === 'unchecked')
    .map((k) => ({ text: k.text, reason: k.check.kind === 'unchecked' ? k.check.reason : '' }));
  const statePath = join(ctx.root, '.oodle', 'gaps-state.json');
  const last = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { last_agreeing_spec: string; at: string }) : undefined;
  const { spec } = loadSpec(ctx.root);
  const current = specHash(spec);
  const by = (route: string, tier: string) => open.filter((g) => g.route === route && g.tier === tier);
  ctx.print(
    `spec ${current.slice(0, 12)}${last ? (last.last_agreeing_spec === current ? ' — builds agree on it' : ` — builds last agreed on ${last.last_agreeing_spec.slice(0, 12)} (${last.at})`) : ' — no gaps run yet'}`,
  );
  ctx.print(`open gaps: ${open.length}`);
  for (const [route, tier] of [
    ['human', 'declared'],
    ['human', 'decided'],
    ['agent', 'decided'],
  ] as const) {
    const list = by(route, tier);
    if (list.length) ctx.print(`  ${route}, ${tier}: ${list.length}\n${list.map((g) => `    ${g.id} ${g.question}`).join('\n')}`);
  }
  if (unchecked.length) ctx.print(`unchecked: ${unchecked.length}\n${unchecked.map((u) => `  ${u.text} (${u.reason})`).join('\n')}`);
  const latest = join(ctx.root, '.oodle', 'builds', 'latest');
  if (existsSync(latest)) ctx.print(`latest build: ${readFileSync(latest, 'utf8').trim()}`);
  return done(ctx, {
    spec_hash: current,
    last_agreeing_spec: last?.last_agreeing_spec ?? null,
    agree: last?.last_agreeing_spec === current,
    open: open.map(brief),
    by_route: { human: open.filter((g) => g.route === 'human').length, agent: open.filter((g) => g.route === 'agent').length },
    unchecked,
    applied: gaps.filter((g) => g.status === 'applied').length,
  });
}

// ── export ──────────────────────────────────────────────────────────────────

export function exportCommand(ctx: Ctx, buildId: string, dest: string): number {
  const b = resolveBuild(ctx, buildId);
  const to = resolve(dest);
  if (existsSync(to)) throw new CliError(`${dest} already exists.`, EXIT.usage);
  mkdirSync(to, { recursive: true });
  cpSync(b.dir, to, { recursive: true, filter: (src) => !/[/\\](node_modules|\.oodle|\.wrangler)([/\\]|$)/.test(src) });
  ctx.print(`Exported ${b.id ?? b.dir} to ${dest}.`);
  return done(ctx, { exported: to });
}
