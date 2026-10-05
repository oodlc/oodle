import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { AppContext, OodleApp, CreateApp } from './contract.ts';
import type { Behavior, Catalog, Condition, Config, EffectRecord, Gap, Given, Observation, Outcome, RunResult, Stub } from './types.ts';
import { loadCatalog, loadConfig } from './catalog.ts';
import { lint } from './lint.ts';
import { evaluate } from './expect.ts';
import { OodleError } from './errors.ts';

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Later layers win; objects merge, arrays and scalars replace. */
export function mergeGiven(...layers: (Given | undefined)[]): Given {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (isPlainObject(a) && isPlainObject(b)) {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
      return out;
    }
    return b;
  };
  return layers.reduce<Given>((acc, layer) => merge(acc, layer ?? {}) as Given, {});
}

export async function loadApp(projectDir: string, config: Config): Promise<CreateApp> {
  const url = pathToFileURL(resolve(projectDir, config.app)).href;
  let mod: any;
  try {
    mod = await import(url);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && (err as Error).message.includes(resolve(projectDir, config.app));
    throw new OodleError('app-load', missing ? `App not found at ${config.app}` : `Could not load the app at ${config.app}`, {
      problems: missing ? [] : [(err as Error).message.split('\n')[0]],
      hint: missing ? 'Point "app" in oodle.yaml at the module whose default export is createApp(ctx).' : 'Fix the error above, then run again. Add --debug for the full stack.',
    });
  }
  const createApp = mod.default ?? mod.createApp;
  if (typeof createApp !== 'function') {
    throw new OodleError('app-contract', `${config.app} does not export createApp(ctx)`, {
      hint: 'Export it as the default: export default function createApp(ctx) { return { routes, handle } }',
    });
  }
  return createApp as CreateApp;
}

interface Sim {
  ctx: AppContext;
  effects: EffectRecord[];
  virtualMs: () => number;
}

function simulate(given: Given): Sim {
  const effects: EffectRecord[] = [];
  const counters: Record<string, number> = {};
  let virtual = 0;
  const boundaryOf = (kind: string) => (kind.startsWith('internal.') ? 'internal' : 'external') as EffectRecord['boundary'];
  const ctx: AppContext = {
    state: structuredClone(given.state ?? {}) as Record<string, any>,
    id: (prefix) => `${prefix}_${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`,
    now: () => FIXED_NOW,
    effects: {
      emit(kind, payload) {
        effects.push({ kind, boundary: boundaryOf(kind), payload: structuredClone(payload ?? {}) });
      },
      async call(kind, payload) {
        const stub: Stub | undefined = given.stubs?.[kind];
        if (!stub) {
          const error = `no stub for external call "${kind}"; add one under defaults.given.stubs or a condition`;
          effects.push({ kind, boundary: boundaryOf(kind), payload: structuredClone(payload ?? {}), error });
          throw new Error(error);
        }
        virtual += stub.latency_ms ?? 0;
        if (stub.error) {
          effects.push({ kind, boundary: boundaryOf(kind), payload: structuredClone(payload ?? {}), error: stub.error });
          throw new Error(stub.error);
        }
        const result = structuredClone(stub.result);
        effects.push({ kind, boundary: boundaryOf(kind), payload: structuredClone(payload ?? {}), result });
        return structuredClone(result) as any;
      },
    },
  };
  return { ctx, effects, virtualMs: () => virtual };
}

/**
 * Every constraint is checked on every run: outcomes, behaviors and probes of unknown routes.
 * An invariant that only holds on the paths someone described is not an invariant. See docs/decisions/0002.
 */
function checkConstraints(catalog: Catalog, effects: EffectRecord[], state: unknown, response: unknown): string[] {
  const violations: string[] = [];
  for (const c of catalog.constraints) {
    try {
      const fn = new Function('effects', 'state', 'response', `return (${c.check});`);
      if (!fn(effects, state, response)) violations.push(`constraint ${c.id} violated: ${c.statement}`);
    } catch (err) {
      // Fail closed: a check that cannot be evaluated is not evidence the invariant holds.
      violations.push(`constraint ${c.id} errored: ${(err as Error).message}`);
    }
  }
  return violations;
}

export type Subject = { kind: 'outcome'; item: Outcome } | { kind: 'behavior'; item: Behavior };

/**
 * Runs one outcome or behavior under one condition. Outcomes are checked against
 * `expect`, behaviors against their `observed` snapshot, and both against every constraint.
 */
export async function runSubject(createApp: CreateApp, catalog: Catalog, config: Config, subject: Subject, condition: Condition | null): Promise<Observation> {
  const { item } = subject;
  const given = mergeGiven(config.defaults?.given, item.trigger.given, condition?.given);
  const sim = simulate(given);
  const [method, path] = item.trigger.http.split(' ');
  const obs: Observation = { kind: subject.kind, id: item.id, condition: condition?.id ?? 'default', status: null, body: undefined, effects: sim.effects, latency_ms: 0, failures: [], violations: [] };

  const t0 = performance.now();
  try {
    const app = createApp(sim.ctx);
    const res = await app.handle({ method, path, body: structuredClone(given.body) });
    obs.status = res.status;
    obs.body = res.body;
  } catch (err) {
    obs.error = (err as Error).message;
  }
  obs.latency_ms = Math.round(performance.now() - t0 + sim.virtualMs());

  if (obs.error) obs.failures.push(`app threw: ${obs.error}`);
  if (subject.kind === 'outcome') obs.failures.push(...evaluate(subject.item.expect, obs));
  else if (subject.item.observed) obs.failures.push(...evaluate(subject.item.observed, obs));
  obs.violations = checkConstraints(catalog, sim.effects, sim.ctx.state, { status: obs.status, body: obs.body });
  return obs;
}

function routeRegex(pattern: string): RegExp {
  const escaped = pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${escaped}$`);
}

async function findGaps(createApp: CreateApp, catalog: Catalog, config: Config, app: OodleApp): Promise<Gap[]> {
  const gaps: Gap[] = [];
  const triggers = [...catalog.outcomes, ...catalog.behaviors].map((x) => x.trigger.http.split(' '));
  for (const route of app.routes) {
    const covered = triggers.some(([m, p]) => m === route.method && routeRegex(route.path).test(p.split('?')[0]));
    if (covered) continue;

    // Nobody described this route. Probe it inside the simulation (every outbound effect is stubbed or recorded,
    // never real) and propose what was observed as a behavior.
    const probePath = route.path.replace(/:[^/]+/g, 'probe');
    const given = mergeGiven(config.defaults?.given);
    const sim = simulate(given);
    let probe: Gap['probe'] = { status: null, body: undefined };
    try {
      const res = await createApp(sim.ctx).handle({ method: route.method, path: probePath, body: route.method === 'GET' ? undefined : {} });
      probe = { status: res.status, body: res.body };
    } catch (err) {
      probe = { status: null, body: undefined, error: (err as Error).message };
    }
    const violations = checkConstraints(catalog, sim.effects, sim.ctx.state, { status: probe.status, body: probe.body });
    const slug = `${route.method.toLowerCase()}${route.path.replace(/[/:]+/g, '-').replace(/-+$/, '')}`;
    gaps.push({
      route: `${route.method} ${route.path}`,
      probe,
      violations,
      proposal: {
        id: `observed.${slug}`,
        statement: `TODO: describe what ${route.method} ${route.path} does for the caller`,
        boundary: 'external',
        trigger: { http: `${route.method} ${probePath}` },
        ...(probe.status !== null ? { observed: { status: probe.status } } : {}),
      },
    });
  }
  return gaps;
}

export interface RunOptions {
  /** Only run outcomes and behaviors whose id matches one of these globs (`*` wildcard). */
  only?: string[];
  /** Called before each run, for progress display. */
  onProgress?: (label: string, done: number, total: number) => void;
}

export const globMatcher = (patterns: string[]) => {
  const res = patterns.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return (id: string) => res.some((r) => r.test(id));
};

export async function runProject(projectDir: string, opts: RunOptions = {}): Promise<RunResult> {
  const config = loadConfig(projectDir);
  const catalog = loadCatalog(projectDir, config);
  const lintResult = lint(catalog);
  const createApp = await loadApp(projectDir, config);
  const conditions = new Map(catalog.conditions.map((c) => [c.id, c]));

  const observations: Observation[] = [];
  const selected = opts.only?.length ? globMatcher(opts.only) : () => true;
  const subjects: Subject[] = [
    ...catalog.outcomes.map((item) => ({ kind: 'outcome' as const, item })),
    ...catalog.behaviors.map((item) => ({ kind: 'behavior' as const, item })),
  ].filter((s) => selected(s.item.id));
  if (opts.only?.length && !subjects.length) {
    const ids = [...catalog.outcomes, ...catalog.behaviors].map((x) => x.id);
    throw new OodleError('no-match', `Nothing matches ${opts.only.map((p) => `"${p}"`).join(', ')}`, {
      hint: `Ids in this catalog: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}. Use * as a wildcard, e.g. "checkout.*".`,
    });
  }
  const plan = subjects.flatMap((subject) => {
    const conds = (subject.item.conditions ?? []).map((id) => conditions.get(id)).filter((c): c is Condition => !!c);
    return (conds.length ? conds : [null]).map((c) => ({ subject, c }));
  });
  for (const [i, { subject, c }] of plan.entries()) {
    opts.onProgress?.(`${subject.item.id}${c ? ` · ${c.id}` : ''}`, i, plan.length);
    observations.push(await runSubject(createApp, catalog, config, subject, c));
  }

  let probeApp: OodleApp;
  try {
    probeApp = createApp(simulate(mergeGiven(config.defaults?.given)).ctx);
  } catch (err) {
    throw new OodleError('app-crash', `createApp(ctx) threw: ${(err as Error).message}`, {
      hint: 'createApp runs with the state from defaults.given in oodle.yaml. Seed what it needs there, or make it tolerate an empty state.',
    });
  }
  const routes = probeApp.routes.map((r) => `${r.method} ${r.path}`);
  const gaps = await findGaps(createApp, catalog, config, probeApp);
  return { projectDir, config, catalog, lint: lintResult, routes, observations, gaps };
}
