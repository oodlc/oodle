import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { AppContext, OodleApp, CreateApp, Request } from './contract.ts';
import type { Behavior, Catalog, Condition, Config, EffectRecord, Expect, Gap, Given, Observation, Outcome, RunResult, Stub } from './types.ts';
import { loadCatalog, loadConfig } from './catalog.ts';
import { lint } from './lint.ts';
import { evaluate } from './expect.ts';
import { OodleError } from './errors.ts';
import { allConditions, fuzzBody, takePollution } from './security.ts';
import { recordEscapes, seal, sealViolations } from './seal.ts';

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
    // The app file itself is missing, not something it imports (whose error also names the app, as "imported from").
    const missing = !existsSync(resolve(projectDir, config.app));
    throw new OodleError('app-load', missing ? `App not found at ${config.app}` : `Could not load the app at ${config.app}`, {
      // Compiler errors (esbuild via tsx) put the useful part, file:line:col and the message, after the first line.
      problems: missing ? [] : (err as Error).message.split('\n').filter((l) => l.trim()).slice(0, 8).map((l) => l.replaceAll(`${resolve(projectDir)}/`, `${relative(process.cwd(), resolve(projectDir)) || '.'}/`)),
      cause: err,
      hint: missing ? 'Point "app" in oodlc/config.yaml at the module whose default export is createApp(ctx).' : 'Fix the error above, then run again. Add --debug for the full stack.',
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

const NO_STUB = 'no stub for external call';

/** One line per external call that had no stub, which is usually why a run failed. */
function missingStubs(effects: EffectRecord[]): string[] {
  return [...new Set(effects.filter((e) => e.error?.startsWith(NO_STUB)).map((e) => e.error!))];
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
          const error = `${NO_STUB} "${kind}"; add one under defaults.given.stubs in oodlc/config.yaml, or in a condition`;
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

/** The request a run sends: the merged body, fuzzed if asked, and headers with dropped ones removed. */
export function requestFor(method: string, path: string, given: Given): Request {
  const body = given.fuzz ? fuzzBody(structuredClone(given.body), given.fuzz) : structuredClone(given.body);
  const headers = given.headers ? Object.fromEntries(Object.entries(given.headers).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined;
  return { method, path, body, ...(headers ? { headers } : {}) };
}

interface Checked {
  /** Breaches of approved constraints. Blocking. */
  violations: string[];
  /** Breaches of proposed constraints. Reported only. See docs/decisions/0006. */
  notices: string[];
}

/**
 * Every constraint is checked on every run: outcomes, behaviors and probes of unknown routes.
 * An invariant that only holds on the paths someone described is not an invariant. See docs/decisions/0002.
 */
function checkConstraints(catalog: Catalog, effects: EffectRecord[], state: unknown, response: unknown, request: Request): Checked {
  const out: Checked = { violations: [], notices: [] };
  for (const c of catalog.constraints) {
    const into = c.status === 'proposed' ? out.notices : out.violations;
    const tag = c.status === 'proposed' ? 'proposed constraint' : 'constraint';
    try {
      const fn = new Function('effects', 'state', 'response', 'request', `return (${c.check});`);
      if (!fn(effects, state, response, request)) into.push(`${tag} ${c.id} violated: ${c.statement}`);
    } catch (err) {
      // Fail closed: a check that cannot be evaluated is not evidence the invariant holds.
      into.push(`${tag} ${c.id} errored: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Built-in invariants every run holds to, whatever the catalog says: the simulation is sealed, and the prototype stays clean. */
function builtinViolations(escapes: string[]): string[] {
  const out = sealViolations(escapes);
  if (takePollution()) out.push('constraint oodle.prototype-pollution violated: a request body\'s __proto__ field reached Object.prototype');
  return out;
}

/** Sends the request `repeat` times against one app instance; the last response is the one observed. */
async function send(app: OodleApp, req: Request, repeat = 1) {
  let res = await app.handle(structuredClone(req));
  for (let i = 1; i < repeat; i++) res = await app.handle(structuredClone(req));
  return res;
}

/** The expectation under one condition: `when` fields replace the same fields of `expect`. See docs/decisions/0004. */
export function expectFor(outcome: Outcome, condition: string | undefined): Expect {
  const override = condition ? outcome.when?.[condition] : undefined;
  return override ? { ...outcome.expect, ...override } : outcome.expect;
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
  const obs: Observation = { kind: subject.kind, id: item.id, condition: condition?.id ?? 'default', status: null, body: undefined, effects: sim.effects, latency_ms: 0, failures: [], violations: [], notices: [] };
  if (subject.kind === 'outcome' && subject.item.status === 'proposed') obs.proposed = true;
  const req = requestFor(method, path, given);

  const t0 = performance.now();
  const { escapes } = await recordEscapes(async () => {
    try {
      const res = await send(createApp(sim.ctx), req, given.repeat);
      obs.status = res.status;
      obs.body = res.body;
    } catch (err) {
      obs.error = (err as Error).message;
    }
  });
  obs.latency_ms = Math.round(performance.now() - t0 + sim.virtualMs());

  if (obs.error) obs.failures.push(`app threw: ${obs.error}`);
  if (subject.kind === 'outcome') obs.failures.push(...evaluate(expectFor(subject.item, condition?.id), obs));
  else if (subject.item.observed) obs.failures.push(...evaluate(subject.item.observed, obs));
  // A missing stub usually surfaces as a 500 or a wrong body. Name it first, since it is the thing to fix.
  if (obs.failures.length) obs.failures.unshift(...missingStubs(sim.effects).filter((m) => obs.error !== m));
  const checked = checkConstraints(catalog, sim.effects, sim.ctx.state, { status: obs.status, body: obs.body }, req);
  obs.violations = [...checked.violations, ...builtinViolations(escapes)];
  obs.notices = checked.notices;
  return obs;
}

function routeRegex(pattern: string): RegExp {
  const escaped = pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${escaped}$`);
}

async function findGaps(createApp: CreateApp, catalog: Catalog, config: Config, app: OodleApp, conditions: Map<string, Condition>): Promise<Gap[]> {
  const gaps: Gap[] = [];
  const triggers = [...catalog.outcomes, ...catalog.behaviors].map((x) => x.trigger.http.split(' '));
  for (const route of app.routes) {
    const covered = triggers.some(([m, p]) => m === route.method && routeRegex(route.path).test(p.split('?')[0]));
    if (covered) continue;

    // Nobody described this route. Probe it inside the simulation (every outbound effect is stubbed or recorded,
    // never real) and propose what was observed as a behavior. Constraints are checked on the default probe and
    // on one probe per condition in `probe.conditions`, so a new route meets the security pack too.
    const probePath = route.path.replace(/:[^/]+/g, 'probe');
    const extra = (config.probe?.conditions ?? []).map((id) => conditions.get(id)).filter((c): c is Condition => !!c);
    let probe: Gap['probe'] = { status: null, body: undefined };
    const violations: string[] = [];
    const notices: string[] = [];
    for (const c of [null, ...extra]) {
      const given = mergeGiven(config.defaults?.given, { body: route.method === 'GET' ? undefined : {} }, c?.given);
      const sim = simulate(given);
      const req = requestFor(route.method, probePath, given);
      let result: Gap['probe'];
      const { escapes } = await recordEscapes(async () => {
        try {
          const res = await send(createApp(sim.ctx), req, given.repeat);
          result = { status: res.status, body: res.body, effects: sim.effects };
        } catch (err) {
          result = { status: null, body: undefined, error: (err as Error).message, effects: sim.effects };
        }
      });
      if (!c) probe = result!;
      const checked = checkConstraints(catalog, sim.effects, sim.ctx.state, { status: result!.status, body: result!.body }, req);
      const label = (v: string) => (c ? `[${c.id}] ${v}` : v);
      violations.push(...[...checked.violations, ...builtinViolations(escapes)].map(label));
      notices.push(...checked.notices.map(label));
    }
    const slug = `${route.method.toLowerCase()}${route.path.replace(/[/:]+/g, '-').replace(/-+$/, '')}`;
    gaps.push({
      route: `${route.method} ${route.path}`,
      probe,
      ...(extra.length ? { probed_under: extra.map((c) => c.id) } : {}),
      violations,
      notices,
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
  const lintResult = lint(catalog, config);
  const unseal = config.sealed === false ? () => {} : seal(typeof config.sealed === 'object' ? config.sealed.allow : []);
  try {
    return await runSealed(projectDir, config, catalog, lintResult, opts);
  } finally {
    unseal();
  }
}

async function runSealed(projectDir: string, config: Config, catalog: Catalog, lintResult: RunResult['lint'], opts: RunOptions): Promise<RunResult> {
  const { value: createApp, escapes } = await recordEscapes(() => loadApp(projectDir, config));
  if (escapes.length) {
    throw new OodleError('sealed', `${config.app} reached the real network while loading`, {
      problems: [...new Set(escapes)],
      hint: 'Oodle runs apps in a sealed simulation. Move the call behind ctx.effects, or list the host under sealed.allow in oodlc/config.yaml.',
    });
  }
  const conditions = allConditions(catalog);

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
      cause: err,
      hint: 'createApp runs with the state from defaults.given in oodlc/config.yaml. Seed what it needs there, or make it tolerate an empty state.',
    });
  }
  const routes = probeApp.routes.map((r) => `${r.method} ${r.path}`);
  const gaps = await findGaps(createApp, catalog, config, probeApp, conditions);
  return { projectDir, config, catalog, lint: lintResult, routes, observations, gaps };
}
