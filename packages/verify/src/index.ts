/**
 * @oodle/verify: one build against the spec. What blocks, in order:
 *
 * 1. static: the determinism check, the driver implementing the whole vocabulary, the build's own
 *    typecheck (when its dependencies are installed), and what merged intents rule out;
 * 2. journeys: every compiled journey's expectations, named by journey, step and prose line;
 * 3. constraints checked on every build, and the sealed simulation (no escapes);
 * 4. pinned decisions.
 *
 * A constraint or decision the compiler couldn't turn into a check is a warning, never skipped
 * silently.
 */
import { type Compiled, type CompiledCheck, checkId } from '@oodle/compile';
import {
  type Fixture,
  type LoadedBuild,
  loadBuild,
  type Observation,
  personaOf,
  runScenarios,
  type Scenario,
  type ScenarioResult,
  screenText,
} from '@oodle/sim';
import { describeView, unmet } from './expect.ts';
import { determinismViolations, driverGaps, typecheck } from './static.ts';

export * from './expect.ts';
export * from './static.ts';

export type Stage = 'static' | 'journey' | 'constraint' | 'decision' | 'sealed' | 'intent';

export interface Finding {
  stage: Stage;
  blocking: boolean;
  /** What it is about: a journey id, a constraint's text, a decision id, a file. */
  subject: string;
  message: string;
}

export interface VerifyReport {
  build: string;
  passed: boolean;
  findings: Finding[];
  /** Journey id → passed. */
  journeys: Record<string, boolean>;
  /** Check id → passed, failed or unchecked. */
  checks: Record<string, 'passed' | 'failed' | 'unchecked'>;
  /** Every scenario's observations, keyed by scenario id, for the gaps check to reuse. */
  results: ScenarioResult[];
  /** Steps run, and how long it took. */
  stats: { scenarios: number; steps: number; ms: number };
}

/** Extra checks a merged intent adds (phase 9 fills these in). */
export interface IntentChecks {
  /** Blocking findings computed outside the simulation, like a new dependency. */
  findings?: Finding[];
  /** Journeys that must exist and pass. */
  journeys?: string[];
}

export interface VerifyOptions {
  /** Run the build's own typecheck when it has node_modules. Default true. */
  typecheck?: boolean;
  /** Spread scenarios over this many instances. */
  parallel?: number;
  seed?: number;
  intents?: IntentChecks;
  /** Run the exploration plan too (needed for property checks and the gaps check). Default true. */
  explore?: boolean;
}

export async function verify(buildDir: string, compiled: Compiled, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const started = performance.now();
  const findings: Finding[] = [...(opts.intents?.findings ?? [])];
  const report: VerifyReport = { build: buildDir, passed: false, findings, journeys: {}, checks: {}, results: [], stats: { scenarios: 0, steps: 0, ms: 0 } };
  const block = (stage: Stage, subject: string, message: string) => findings.push({ stage, blocking: true, subject, message });
  const warn = (stage: Stage, subject: string, message: string) => findings.push({ stage, blocking: false, subject, message });

  if (!compiled.vocabulary) {
    block('static', 'oodle/compiled', 'nothing is compiled yet: run `oodle compile`');
    return finish(report, started);
  }

  for (const v of determinismViolations(buildDir)) block('static', `${v.file}:${v.line}`, v.what);
  if (opts.typecheck !== false) {
    const errors = typecheck(buildDir);
    if (errors === null) warn('static', 'typecheck', 'skipped: the build has no node_modules');
    else for (const e of errors) block('static', 'typecheck', e);
  }

  let build: LoadedBuild;
  try {
    build = await loadBuild(buildDir);
  } catch (e) {
    block('static', 'bundle', (e as Error).message);
    return finish(report, started);
  }
  for (const m of driverGaps(build.driver, compiled.vocabulary)) block('static', 'src/oodle.driver.ts', `the driver is missing ${m}`);

  const checkScenarios = compiled.checks.flatMap((c) => (c.check.kind === 'scenario' ? [c.check.scenario as Scenario] : []));
  const scenarios: Scenario[] = [
    ...compiled.journeys.map((j) => j.scenario as Scenario),
    ...(opts.explore === false ? [] : ((compiled.explore?.scenarios ?? []) as Scenario[])),
    ...checkScenarios,
  ];
  const results = await runScenarios(build, scenarios, { parallel: opts.parallel, seed: opts.seed });
  report.results = results;
  report.stats.scenarios = results.length;
  report.stats.steps = results.reduce((n, r) => n + r.observations.length, 0);
  const byId = new Map(results.map((r) => [r.scenario, r]));

  for (const r of results) for (const e of r.escapes) block('sealed', r.scenario, `${e.method} ${e.url} went around rt(c).fetch; the simulation is sealed`);

  for (const j of compiled.journeys) {
    const result = byId.get(j.scenario.id);
    let ok = !!result;
    for (const [i, step] of j.scenario.steps.entries()) {
      const obs = result?.observations[i];
      if (!obs) continue;
      for (const problem of unmet(step.expect, obs, j.scenario.fixtures)) {
        ok = false;
        const line = step.line ?? i;
        block(
          'journey',
          j.journey,
          `step ${line + 1} ("${j.prose[line] ?? step.prose ?? ''}"), as ${step.as}${step.do ? ` doing ${step.do}` : ''}: ${problem}`,
        );
      }
    }
    report.journeys[j.journey] = ok;
  }
  for (const id of opts.intents?.journeys ?? []) {
    if (!(id in report.journeys)) block('intent', id, `the journey "${id}" must exist and pass`);
  }

  const allObservations = results.flatMap((r) => r.observations.map((o) => ({ o, fixtures: scenarioFixtures(scenarios, r.scenario) })));
  for (const c of compiled.checks) {
    const stage: Stage = 'decision' in c.for ? 'decision' : 'constraint';
    const id = checkId(c.for);
    const problems = evaluateCheck(c, byId, allObservations);
    if (problems === null) {
      report.checks[id] = 'unchecked';
      warn(stage, c.text, `unchecked ${stage}: ${c.check.kind === 'unchecked' ? c.check.reason : ''}`);
    } else if (problems.length) {
      report.checks[id] = 'failed';
      for (const p of problems.slice(0, 5)) block(stage, c.text, p);
    } else report.checks[id] = 'passed';
  }

  return finish(report, started);
}

function finish(report: VerifyReport, started: number): VerifyReport {
  report.passed = !report.findings.some((f) => f.blocking);
  report.stats.ms = Math.round(performance.now() - started);
  return report;
}

const scenarioFixtures = (scenarios: Scenario[], id: string) => scenarios.find((s) => s.id === id)?.fixtures ?? {};

/** Problems with a check, or null when it can't be checked. */
function evaluateCheck(c: CompiledCheck, byId: Map<string, ScenarioResult>, all: { o: Observation; fixtures: Record<string, Fixture> }[]): string[] | null {
  const check = c.check;
  switch (check.kind) {
    case 'unchecked':
      return null;
    case 'scenario': {
      const result = byId.get(check.scenario.id);
      if (!result) return ['its scenario did not run'];
      return check.scenario.steps.flatMap((step, i) => {
        const obs = result.observations[i];
        return obs
          ? unmet(step.expect, obs, check.scenario.fixtures as Record<string, Fixture>).map(
              (p) => `step ${i + 1}, as ${step.as}${step.do ? ` doing ${step.do}` : ''}: ${p}`,
            )
          : [];
      });
    }
    case 'never_shows_field': {
      const out: string[] = [];
      for (const { o, fixtures } of all) {
        if (!check.viewers.includes(personaOf(o.as))) continue;
        const text = screenText(o.view);
        for (const [key, f] of Object.entries(fixtures)) {
          const value = f[check.field];
          if (key === o.as || !check.owners.includes(personaOf(key)) || typeof value !== 'string' || !value) continue;
          if (text.includes(value)) out.push(`${o.scenario}, step ${o.step + 1}: ${o.as} sees ${key}'s ${check.field} ("${value}") on ${describeView(o.view)}`);
        }
      }
      return out;
    }
    case 'never_matches': {
      const re = new RegExp(check.pattern, 'i');
      return all
        .filter(({ o }) => !check.viewers || check.viewers.includes(personaOf(o.as)))
        .filter(({ o }) => re.test(screenText(o.view)))
        .map(({ o }) => `${o.scenario}, step ${o.step + 1}: ${o.as} sees ${describeView(o.view)}, which matches /${check.pattern}/`);
    }
  }
}

/** A verify report as people read it. */
export function summarize(report: VerifyReport): string {
  const lines: string[] = [];
  const journeys = Object.entries(report.journeys);
  const checks = Object.values(report.checks);
  lines.push(
    `${report.passed ? 'passed' : 'failed'}: ${journeys.filter(([, ok]) => ok).length}/${journeys.length} journeys, ${checks.filter((c) => c === 'passed').length}/${checks.length} checks (${checks.filter((c) => c === 'unchecked').length} unchecked), ${report.stats.scenarios} scenarios, ${report.stats.steps} steps in ${(report.stats.ms / 1000).toFixed(1)}s`,
  );
  for (const f of report.findings) lines.push(`  ${f.blocking ? '✗' : '!'} [${f.stage}] ${f.subject}: ${f.message}`);
  return lines.join('\n');
}
