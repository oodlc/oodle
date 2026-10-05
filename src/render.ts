/**
 * Human output for the terminal. Results go to stdout and use `out` styles, so
 * they lose colour when piped. Markdown for PR comments lives in report.ts;
 * JSON is the data itself.
 */
import { stringify } from 'yaml';
import type { DiffReport, OutcomeStatus } from './diff.ts';
import { groupByCondition } from './report.ts';
import type { Catalog, LintResult, Observation, RunResult } from './types.ts';
import type { MutantResult, MutateReport } from './mutate.ts';
import { columns, ms, out as s, pad, plural, sym, visible } from './term.ts';

const indent = (n: number) => ' '.repeat(n);
const detail = (text: string) => `      ${s.dim(sym.bar)} ${text}`;

/** One line per distinct finding, labelled with the conditions it happened under. */
function grouped(found: string[], paint = (x: string) => x): string[] {
  const groups = groupByCondition(found);
  const label = (conds: string[]) => (conds.join(', ').length <= 40 ? conds.join(', ') : plural(conds.length, 'condition'));
  const width = Math.max(0, ...groups.map((g) => label(g.conditions).length));
  return groups.map(({ message, conditions }) => detail(conditions.length ? `${s.dim(label(conditions).padEnd(width))}  ${paint(message)}` : paint(message)));
}

function timings(obs: Observation[], room: number): string {
  if (!obs.length) return '';
  if (obs.length === 1 && obs[0].condition === 'default') return s.dim(ms(obs[0].latency_ms));
  const full = obs.map((o) => `${o.condition} ${ms(o.latency_ms)}`).join(` ${sym.dot} `);
  if (full.length <= room) return s.dim(full);
  return s.dim(`${plural(obs.length, 'condition')} ${sym.dot} max ${ms(Math.max(...obs.map((o) => o.latency_ms)))}`);
}

function heading(title: string, note: string): string {
  return `${s.bold(title)}  ${s.dim(note)}`;
}

export interface RunView {
  verbose?: boolean;
  elapsed: number;
  only?: string[];
}

export function renderRun(run: RunResult, view: RunView): string {
  const lines: string[] = [];
  const ran = new Set(run.observations.map((o) => `${o.kind}:${o.id}`));
  const outcomes = run.catalog.outcomes.filter((o) => ran.has(`outcome:${o.id}`) && o.status !== 'proposed');
  const proposals = run.catalog.outcomes.filter((o) => ran.has(`outcome:${o.id}`) && o.status === 'proposed');
  const behaviors = run.catalog.behaviors.filter((b) => ran.has(`behavior:${b.id}`));
  const idWidth = Math.max(0, ...[...outcomes, ...proposals, ...behaviors].map((x) => x.id.length));
  const notices = (obs: Observation[]) => grouped(obs.flatMap((x) => x.notices.map((n) => `[${x.condition}] ${n}`)), s.yellow);
  const room = columns() - idWidth - 22;
  const obsOf = (kind: string, id: string) => run.observations.filter((o) => o.kind === kind && o.id === id);
  const row = (mark: string, id: string, boundary: string, obs: Observation[]) =>
    `  ${mark} ${pad(id, idWidth)}  ${s.dim(pad(boundary, 10))} ${timings(obs, room)}`;

  let broken = 0;
  if (outcomes.length) {
    lines.push(heading('Outcomes', 'declared · blocking'));
    for (const o of outcomes) {
      const obs = obsOf('outcome', o.id);
      const ok = obs.every((x) => !x.failures.length && !x.violations.length);
      if (!ok) broken++;
      lines.push(row(ok ? s.green(sym.ok) : s.red(sym.fail), ok ? o.id : s.bold(o.id), o.boundary, obs));
      if (view.verbose || !ok) lines.push(`      ${s.dim(s.italic(o.statement))}`);
      if (view.verbose && obs.length > 1) lines.push(`      ${s.dim(obs.map((x) => `${x.condition} ${ms(x.latency_ms)}`).join(` ${sym.dot} `))}`);
      lines.push(...grouped(obs.flatMap((x) => [...x.failures, ...x.violations].map((f) => `[${x.condition}] ${f}`)), s.red));
      lines.push(...notices(obs));
    }
    lines.push('');
  }

  let proposedHolding = 0;
  if (proposals.length) {
    lines.push(heading('Proposed', 'drafted · waiting for a human · never blocking'));
    for (const o of proposals) {
      const obs = obsOf('outcome', o.id);
      const ok = obs.every((x) => !x.failures.length && !x.violations.length);
      if (ok) proposedHolding++;
      lines.push(row(ok ? s.blue(sym.ok) : s.blue(sym.unknown), o.id, o.boundary, obs));
      lines.push(`      ${s.dim(s.italic(o.statement))}`);
      lines.push(...grouped(obs.flatMap((x) => x.failures.map((f) => `[${x.condition}] not yet: ${f}`)), s.blue));
      lines.push(...grouped(obs.flatMap((x) => x.violations.map((v) => `[${x.condition}] ${v}`)), s.red));
      lines.push(...notices(obs));
    }
    lines.push('');
  }

  let drifted = 0;
  let violatedBehaviors = 0;
  if (behaviors.length) {
    lines.push(heading('Behaviors', 'observed · report only'));
    for (const b of behaviors) {
      const obs = obsOf('behavior', b.id);
      const violated = obs.some((x) => x.violations.length);
      const drift = obs.some((x) => x.failures.length);
      if (drift) drifted++;
      if (violated) violatedBehaviors++;
      const mark = violated ? s.red(sym.fail) : drift ? s.yellow(sym.drift) : s.cyan(sym.watch);
      lines.push(row(mark, b.id, b.boundary, obs));
      if (view.verbose) lines.push(`      ${s.dim(s.italic(b.statement))}`);
      lines.push(...grouped(obs.flatMap((x) => x.violations.map((v) => `[${x.condition}] ${v}`)), s.red));
      lines.push(...grouped(obs.flatMap((x) => x.failures.map((f) => `[${x.condition}] drift: ${f}`)), s.yellow));
      lines.push(...notices(obs));
    }
    lines.push('');
  }

  if (run.gaps.length) {
    lines.push(heading('Unknown routes', 'nothing describes these · probed in simulation'));
    for (const g of run.gaps) {
      const mark = g.violations.length ? s.red(sym.fail) : s.magenta(sym.unknown);
      const result = g.probe.status !== null ? `returned ${g.probe.status}` : `errored: ${g.probe.error}`;
      lines.push(`  ${mark} ${pad(g.route, idWidth)}  ${s.dim(result)}`);
      for (const v of g.violations) lines.push(detail(s.red(v)));
      for (const n of g.notices ?? []) lines.push(detail(s.yellow(n)));
    }
    if (view.verbose) {
      lines.push('');
      lines.push(s.dim('  Proposed catalog entries (review, then keep as behaviors or promote to outcomes):'));
      for (const l of stringify({ behaviors: run.gaps.map((g) => g.proposal) }).trimEnd().split('\n')) lines.push(`    ${s.dim(l)}`);
    }
    lines.push('');
  }

  if (run.lint.errors.length || run.lint.warnings.length) {
    lines.push(lintHeading(run.lint));
    lines.push(...lintLines(run.lint));
    lines.push('');
  }

  // The verdict goes last, where the eye lands.
  const gapViolations = run.gaps.filter((g) => g.violations.length).length;
  const violatedProposals = proposals.filter((o) => obsOf('outcome', o.id).some((x) => x.violations.length)).length;
  const blocking = broken + violatedBehaviors + violatedProposals + gapViolations + run.lint.errors.length;
  const verdict = blocking
    ? s.red(s.bold(`${sym.fail} ${broken ? `${broken} of ${plural(outcomes.length, 'outcome')} not holding` : `${plural(blocking, 'blocking problem')}`}`))
    : outcomes.length
      ? s.green(s.bold(`${sym.ok} ${outcomes.length === 1 ? 'The outcome holds' : `All ${outcomes.length} outcomes hold`}`))
      : view.only?.length
        ? s.green(s.bold(`${sym.ok} Nothing blocking`))
        : s.yellow(s.bold(`${sym.warn} No outcomes declared yet`));
  const facts = [
    proposals.length && `${proposedHolding} of ${plural(proposals.length, 'proposed outcome')} holding`,
    behaviors.length && `${plural(behaviors.length, 'behavior')} watched${drifted ? `, ${drifted} drifted` : ''}`,
    run.gaps.length && plural(run.gaps.length, 'unknown route'),
    run.lint.errors.length && plural(run.lint.errors.length, 'lint error'),
    run.lint.warnings.length && plural(run.lint.warnings.length, 'lint warning'),
    view.only?.length && `filtered by ${view.only.join(', ')}`,
    `${plural(run.observations.length, 'run')} in ${ms(view.elapsed)}`,
  ].filter(Boolean);
  lines.push(`${verdict}  ${s.dim(facts.join(` ${sym.dot} `))}`);
  return lines.join('\n');
}

const lintHeading = (l: LintResult) => heading('Catalog lint', l.errors.length ? 'errors block' : 'warnings only · not blocking');

/** Lint strings look like "file: id: message" or "file: message". */
function splitLint(line: string): { file: string; rest: string } {
  const i = line.indexOf(': ');
  return i > 0 && /\.ya?ml$|oodle\.yaml/.test(line.slice(0, i)) ? { file: line.slice(0, i), rest: line.slice(i + 2) } : { file: '', rest: line };
}

function lintLines(result: LintResult): string[] {
  const lines: string[] = [];
  const byFile = new Map<string, { level: 'error' | 'warning'; text: string }[]>();
  for (const [level, list] of [['error', result.errors], ['warning', result.warnings]] as const) {
    for (const l of list) {
      const { file, rest } = splitLint(l);
      byFile.set(file, [...(byFile.get(file) ?? []), { level, text: rest }]);
    }
  }
  for (const [file, items] of byFile) {
    if (file) lines.push(`  ${s.underline(file)}`);
    for (const { level, text } of items) {
      const tag = level === 'error' ? s.red(`${sym.fail} error  `) : s.yellow(`${sym.warn} warning`);
      const m = /^([a-z0-9][a-z0-9._-]*): (.*)$/.exec(text);
      lines.push(`    ${tag}  ${m ? `${s.bold(m[1])}  ${m[2]}` : text}`);
    }
  }
  return lines;
}

export function renderLint(result: LintResult, catalog: Catalog): string {
  const lines = lintLines(result);
  const counts = [
    plural(catalog.intents.length, 'intent'),
    plural(catalog.outcomes.length, 'outcome'),
    plural(catalog.behaviors.length, 'behavior'),
    plural(catalog.conditions.length, 'condition'),
    plural(catalog.constraints.length, 'constraint'),
  ].join(` ${sym.dot} `);
  if (lines.length) lines.push('');
  const verdict = result.errors.length
    ? s.red(s.bold(`${sym.fail} ${plural(result.errors.length, 'error')}`))
    : s.green(s.bold(`${sym.ok} Catalog is valid`));
  const warn = result.warnings.length ? s.yellow(`${plural(result.warnings.length, 'warning')}`) : '';
  lines.push([verdict, warn, s.dim(counts)].filter(Boolean).join(`  `));
  return lines.join('\n');
}

const STATUS: Record<OutcomeStatus, (t: string) => string> = {
  held: s.green, changed: s.yellow, broken: s.red, failing: s.red, new: s.cyan, removed: s.red, redefined: s.magenta, proposed: s.blue,
};
const MARK: Record<OutcomeStatus, string> = {
  held: sym.ok, changed: sym.drift, broken: sym.fail, failing: sym.fail, new: '+', removed: '-', redefined: sym.drift, proposed: sym.unknown,
};

export function renderDiff(r: DiffReport, view: { verbose?: boolean; base: string; head: string; elapsed: number }): string {
  const lines: string[] = [];
  const count = (st: string) => r.outcomes.filter((o) => o.status === st).length;
  lines.push(s.dim(`${view.base} ${sym.arrow} ${view.head}`));
  lines.push('');

  const shown = r.outcomes.filter((o) => view.verbose || o.status !== 'held');
  const idWidth = Math.max(0, ...shown.map((o) => o.id.length));
  if (shown.length) {
    lines.push(heading('Outcomes', 'declared · any change needs a human'));
    for (const o of shown) {
      const paint = STATUS[o.status];
      const tag = o.approved_by ? `  ${s.green(`approved${o.approved_by.length ? ` by ${o.approved_by.join(', ')}` : ''}`)}` : o.blocking ? `  ${s.red(s.bold('blocking'))}` : '';
      lines.push(`  ${paint(MARK[o.status])} ${paint(pad(o.status, 9))} ${pad(o.blocking ? s.bold(o.id) : o.id, idWidth)}  ${s.dim(o.boundary)}${tag}`);
      if (o.status !== 'held') lines.push(`      ${s.dim(s.italic(o.statement))}`);
      if (o.status !== 'new' || o.blocking) lines.push(...grouped(o.details));
    }
    lines.push('');
  }

  if (r.constraints.length) {
    lines.push(heading('Constraints', 'durable · changing one needs a human'));
    for (const c of r.constraints) {
      const tag = c.approved_by ? `  ${s.green(`approved${c.approved_by.length ? ` by ${c.approved_by.join(', ')}` : ''}`)}` : c.blocking ? `  ${s.red(s.bold('blocking'))}` : '';
      lines.push(`  ${c.blocking ? s.red(sym.fail) : c.approved_by ? s.green(sym.ok) : s.cyan('+')} ${pad(c.status, 9)} ${c.id}${tag}`);
      for (const d of c.details) lines.push(detail(d));
    }
    lines.push('');
  }

  const violating = [
    ...r.behaviors.filter((b) => b.blocking).map((b) => ({ where: `behavior ${b.id}`, violations: b.violations })),
    ...r.gaps.filter((g) => g.violations.length).map((g) => ({ where: `unknown route ${g.route}`, violations: g.violations })),
  ];
  if (violating.length) {
    lines.push(heading('Constraint violations', 'constraints hold on every run · blocking'));
    for (const v of violating) {
      lines.push(`  ${s.red(sym.fail)} ${v.where}`);
      lines.push(...grouped(v.violations, s.red));
    }
    lines.push('');
  }

  const inside = r.outcomes.filter((o) => o.behavior.length);
  const behaviors = r.behaviors.filter((b) => b.status !== 'held');
  if (inside.length || behaviors.length) {
    lines.push(heading('Behavior changes', 'observed · report only, never blocking'));
    for (const o of inside) {
      lines.push(`  ${s.yellow(sym.drift)} under ${o.id}`);
      lines.push(...grouped(o.behavior, s.dim));
    }
    for (const b of behaviors) {
      lines.push(`  ${s.yellow(sym.drift)} ${b.id} ${s.dim(b.status)}`);
      lines.push(...grouped(b.details, s.dim));
    }
    lines.push('');
  }

  if (r.gaps.length) {
    lines.push(heading('Unknown routes', 'nothing describes these'));
    for (const g of r.gaps) lines.push(`  ${s.magenta(sym.unknown)} ${g.route}  ${s.dim(g.probe.status !== null ? `returned ${g.probe.status}` : `errored: ${g.probe.error}`)}`);
    lines.push('');
  }

  if (r.lint.errors.length || r.lint.warnings.length) {
    lines.push(lintHeading(r.lint));
    lines.push(...lintLines(r.lint));
    lines.push('');
  }

  if (r.approvals.stale.length) {
    lines.push(heading('Stale approvals', 'matched nothing · not applied'));
    for (const a of r.approvals.stale) lines.push(`  ${s.yellow(sym.warn)} ${a.id}@${a.fingerprint}${a.by ? s.dim(` by ${a.by}`) : ''}  ${s.dim(a.reason)}`);
    lines.push('');
  }

  const drifted = behaviors.length + inside.length;
  const tally = [
    `${count('held')} held`,
    count('changed') && `${count('changed')} changed`,
    count('broken') + count('failing') && `${count('broken') + count('failing')} broken`,
    count('new') && `${count('new')} new`,
    count('removed') && `${count('removed')} removed`,
    count('redefined') && `${count('redefined')} redefined`,
    r.gaps.length && `${r.gaps.length} unknown`,
    drifted && plural(drifted, 'behavior change'),
    `in ${ms(view.elapsed)}`,
  ].filter(Boolean).join(` ${sym.dot} `);
  const verdict = r.blocking
    ? s.red(s.bold(`${sym.fail} ${r.blocking} blocking`))
    : s.green(s.bold(`${sym.ok} Nothing blocking`));
  lines.push(`${verdict}  ${s.dim(tally)}`);
  return lines.join('\n');
}

export function renderMutate(r: MutateReport, view: { verbose?: boolean; minScore?: number }): string {
  const lines: string[] = [];
  const pct = Math.round(r.score * 100);
  const loc = (m: MutantResult) => `${m.file}:${m.line}`;
  const change = (m: MutantResult) => (m.to ? `${m.from} ${sym.arrow} ${m.to}` : `removed ${m.from}`);
  const locWidth = Math.max(0, ...r.mutants.map((m) => loc(m).length));
  const row = (mark: string, m: MutantResult, note = '') => `  ${mark} ${pad(loc(m), locWidth)}  ${s.dim(pad(m.operator, 16))} ${change(m).length > 70 ? `${change(m).slice(0, 67)}...` : change(m)}${note ? `  ${s.dim(note)}` : ''}`;

  const survived = r.mutants.filter((m) => m.status === 'survived');
  const noticed = r.mutants.filter((m) => m.status === 'noticed');
  if (survived.length) {
    lines.push(heading('Survived', 'no outcome or constraint noticed these bugs'));
    for (const m of survived) lines.push(row(s.red(sym.fail), m));
    lines.push('');
  }
  if (noticed.length) {
    lines.push(heading('Only noticed', 'output changed but every expectation passed · `oodle check` would hold it for review'));
    for (const m of noticed) lines.push(row(s.yellow(sym.drift), m, m.changed.join(', ')));
    lines.push('');
  }
  if (view.verbose) {
    const caught = r.mutants.filter((m) => m.status === 'killed' || m.status === 'timeout');
    if (caught.length) {
      lines.push(heading('Caught', 'an outcome or constraint failed'));
      for (const m of caught) lines.push(row(s.green(sym.ok), m, m.killed_by.join(', ')));
      lines.push('');
    }
    const invalid = r.mutants.filter((m) => m.status === 'invalid');
    if (invalid.length) {
      lines.push(heading('Invalid', 'the mutant did not load · not counted'));
      for (const m of invalid) lines.push(row(s.dim(sym.dot), m, m.reason));
      lines.push('');
    }
  }
  if (r.killers.length) {
    lines.push(heading('What caught them', 'unique = bugs nothing else catches'));
    const w = Math.max(...r.killers.map((k) => k.id.length));
    for (const k of r.killers) lines.push(`  ${pad(k.id, w)}  ${s.dim(`${plural(k.kills, 'bug')} · ${k.unique} unique`)}`);
    lines.push('');
  }
  if (r.redundant.length) {
    lines.push(heading('Redundant outcomes', 'every bug they catch, a smaller set catches too'));
    for (const id of r.redundant) lines.push(`  ${s.dim(sym.dot)} ${id}`);
    lines.push('');
  }
  if (r.tests) {
    lines.push(heading('Tests', s.dim(r.tests.command)));
    if (r.tests.redundant.length) {
      lines.push(`  ${s.bold('Covered by the catalog')}  ${s.dim(`every planted bug they caught, an outcome caught too · ${plural(r.summary.mutants, 'bug')} planted`)}`);
      for (const t of r.tests.redundant) lines.push(`    ${s.dim(sym.dot)} ${t}`);
      lines.push(`    ${s.dim(`Candidates to delete, after a read: a test can still guard inputs no outcome sends.`)}`);
    }
    if (r.tests.no_kills.length) {
      lines.push(`  ${s.bold('Caught no planted bug')}  ${s.dim('no evidence either way · try more mutants with --max, or --files for the code they test')}`);
      for (const t of r.tests.no_kills) lines.push(`    ${s.dim(sym.dot)} ${t}`);
    }
    const keep = r.tests.killers.filter((k) => k.beyond_catalog);
    if (keep.length) {
      lines.push(`  ${s.bold('Worth keeping')}  ${s.dim('they catch bugs the catalog misses; consider an outcome instead')}`);
      for (const k of keep) lines.push(`    ${s.green(sym.ok)} ${k.id}  ${s.dim(`${k.beyond_catalog} beyond the catalog`)}`);
    }
    if (r.tests.baseline_failing.length) lines.push(`  ${s.yellow(sym.warn)} ${plural(r.tests.baseline_failing.length, 'test')} already failing, ignored`);
    lines.push('');
  }

  const sum = r.summary;
  const verdict = view.minScore !== undefined && pct < view.minScore
    ? s.red(s.bold(`${sym.fail} ${pct}% caught, below ${view.minScore}%`))
    : sum.survived
      ? s.yellow(s.bold(`${sym.warn} ${pct}% of planted bugs caught`))
      : s.green(s.bold(`${sym.ok} ${pct}% of planted bugs caught`));
  const facts = [
    `${sum.killed + sum.timeout} caught`,
    sum.noticed && `${sum.noticed} only noticed`,
    sum.internal && `${sum.internal} internal only`,
    sum.survived && `${sum.survived} survived`,
    sum.invalid && `${sum.invalid} invalid`,
    sum.generated > sum.mutants && `sampled ${sum.mutants} of ${sum.generated}`,
    `${plural(r.files.length, 'file')} in ${ms(r.elapsed_ms)}`,
  ].filter(Boolean);
  lines.push(`${verdict}  ${s.dim(facts.join(` ${sym.dot} `))}`);
  return lines.join('\n');
}

/** Wraps long text to the terminal width, for help screens. */
export function wrap(text: string, width: number, hang = 0): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && visible(line) + 1 + visible(w) > width) {
      lines.push(line);
      line = indent(hang) + w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
