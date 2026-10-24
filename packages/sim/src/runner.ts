/**
 * The simulation: a build's Worker in Miniflare, sealed, driven step by step through its driver.
 *
 * - D1 is in memory. Every scenario starts from an empty database with the build's migrations
 *   applied, and the runtime's clock, ids, PRNG and outbox reset (`/__oodle/reset`).
 * - `OODLE_MODE=sim`. Mail and outbound requests made through `rt(c)` are captured by the runtime.
 *   Anything that reaches the network another way lands in Miniflare's outbound service, gets a
 *   canned answer, and is reported as an escape: the simulation is sealed.
 * - Scenarios run in parallel across a few Miniflare instances; steps within a scenario run in
 *   order. Reusing an instance after a reset is as good as a fresh one (decision 0021) and much
 *   cheaper.
 */
import { OUTBOX_HEADER, type Session } from '@oodle/runtime';

interface Outbox {
  mail: Observation['mail'];
  outbound: { url: string; method: string }[];
}
import { Miniflare, supportedCompatibilityDate } from 'miniflare';
import { type LoadedBuild, statements } from './bundle.ts';
import type { Fixture, Observation, Scenario, ScenarioResult, Step } from './scenario.ts';
import { viewOf } from './view.ts';

const ORIGIN = 'http://app.oodle.test';
export const DEFAULT_START = '2026-11-02T08:00:00.000Z';

export interface SimOptions {
  /** The runtime's PRNG seed. */
  seed?: number;
  /** Miniflare instances to spread scenarios over. */
  parallel?: number;
}

/** One running instance of a build. */
export class Instance {
  private escapes: { url: string; method: string }[] = [];
  /** What the app captured, from response headers, since the step began. */
  private outbox: Outbox = { mail: [], outbound: [] };
  private constructor(
    readonly build: LoadedBuild,
    private readonly mf: Miniflare,
    private readonly seed: number,
  ) {}

  static async start(build: LoadedBuild, opts: SimOptions = {}): Promise<Instance> {
    const d1 = Object.fromEntries((build.wrangler.d1_databases ?? [{ binding: 'DB' }]).map((d) => [d.binding, d.binding]));
    let self: Instance | undefined;
    const mf = new Miniflare({
      modules: true,
      script: build.script,
      // A date newer than this workerd knows can't start; run it at the newest one it does.
      compatibilityDate: [build.wrangler.compatibility_date ?? supportedCompatibilityDate, supportedCompatibilityDate].sort()[0],
      compatibilityFlags: build.wrangler.compatibility_flags ?? [],
      d1Databases: d1,
      bindings: { ...(build.wrangler.vars ?? {}), OODLE_MODE: 'sim', OODLE_SEED: String(opts.seed ?? 0) },
      outboundService: (request: Request) => {
        self?.escapes.push({ url: request.url, method: request.method });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    self = new Instance(build, mf, opts.seed ?? 0);
    await mf.ready;
    return self;
  }

  async dispose() {
    await this.mf.dispose();
  }

  private async request(path: string, init: RequestInit = {}, cookies?: Map<string, string>): Promise<Response> {
    const headers = new Headers(init.headers);
    if (cookies?.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await retryConnect(() => this.mf.dispatchFetch(new URL(path, ORIGIN).href, { ...init, headers, redirect: 'manual' } as never) as unknown as Promise<Response>);
    const outbox = res.headers.get(OUTBOX_HEADER);
    if (outbox) {
      const o = JSON.parse(decodeURIComponent(outbox)) as Outbox;
      this.outbox.mail.push(...o.mail);
      this.outbox.outbound.push(...o.outbound);
    }
    if (cookies) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair = ''] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return res;
  }

  /** Starts a scenario, in one request: empty database with the build's migrations, runtime state reset, fixtures seeded. */
  private async reset(scenario: Scenario) {
    this.escapes = [];
    const sql = this.build.migrations.flatMap(([, text]) => statements(text));
    const users = Object.entries(scenario.fixtures).map(([key, f]) => userOf(key, f));
    await this.expectOk('/__oodle/reset', { method: 'POST', body: JSON.stringify({ seed: this.seed, clock: scenario.start ?? DEFAULT_START, sql, users }) });
  }

  private async expectOk(path: string, init: RequestInit) {
    const res = await this.request(path, { ...init, headers: { 'content-type': 'application/json' } });
    if (res.status >= 300) throw new Error(`${path} answered ${res.status}: ${await res.text()}. Does the app use oodle() from @oodle/runtime?`);
    await res.arrayBuffer();
  }

  async run(scenario: Scenario): Promise<ScenarioResult> {
    await this.reset(scenario);
    const sessions = new Map<string, Session>();
    const created = new Map<string, string[]>();
    const session = async (as: string): Promise<Session> => {
      const existing = sessions.get(as);
      if (existing) return existing;
      const userId = idOf(as);
      if (!scenario.fixtures[as]) throw new Error(`no fixture "${as}"`);
      const jar = new Map<string, string>();
      await (await this.request(`/__oodle/login?user=${encodeURIComponent(userId)}`, {}, jar)).arrayBuffer();
      const s: SessionWithStatus = {
        as,
        userId,
        last: 0,
        lastBody: '',
        fetch: async (path, init) => {
          let res = await this.request(path, init, jar);
          for (let hops = 0; init?.redirect !== 'manual' && res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < 5; hops++) {
            await res.arrayBuffer();
            res = await this.request(res.headers.get('location') as string, {}, jar);
          }
          s.last = res.status;
          s.lastBody = await res.clone().text();
          return res;
        },
      };
      sessions.set(as, s);
      return s;
    };
    const resolveValue = (v: unknown): unknown => {
      if (typeof v !== 'string') return v;
      if (scenario.fixtures[v]) return idOf(v);
      const ref = /^\$([a-z_]+?)_(\d+)$/.exec(v);
      if (ref) return created.get(ref[1] as string)?.[Number(ref[2]) - 1] ?? v;
      return v;
    };

    const observations: Observation[] = [];
    for (const [i, step] of scenario.steps.entries()) {
      observations.push(await this.step(scenario, i, step, session, resolveValue, created));
    }
    return { scenario: scenario.id, observations, escapes: this.escapes };
  }

  private async step(
    scenario: Scenario,
    index: number,
    step: Step,
    session: (as: string) => Promise<Session>,
    resolveValue: (v: unknown) => unknown,
    created: Map<string, string[]>,
  ): Promise<Observation> {
    if (step.at) await this.expectOk('/__oodle/clock', { method: 'POST', body: JSON.stringify({ at: step.at }) });
    this.outbox = { mail: [], outbound: [] };
    const observer = step.look?.as ?? step.as;
    const obs: Observation = { scenario: scenario.id, step: index, as: observer, status: 0, view: viewOf(''), mail: [], outbound: [] };
    let landing: string | undefined;
    try {
      if (step.do) {
        const action = this.build.driver.actions[step.do];
        if (!action) throw new Error(`the driver has no action "${step.do}"`);
        const s = (await session(step.as)) as SessionWithStatus;
        s.last = 0;
        const input = Object.fromEntries(Object.entries(step.input ?? {}).map(([k, v]) => [k, resolveValue(v)]));
        const result = await action(s, input);
        obs.status = s.last;
        if (s.last >= 400 && s.last < 500) obs.blocked = true;
        for (const c of result?.created ?? []) created.set(c.kind, [...(created.get(c.kind) ?? []), c.id]);
        landing = result?.screen;
      }
      const viewer = await session(observer);
      let path = landing;
      let html: string | undefined;
      if (step.do && !landing && !step.look) html = ((await session(step.as)) as SessionWithStatus).lastBody;
      if (step.look?.screen || !step.do) {
        const name = step.look?.screen ?? 'home';
        const screen = this.build.driver.screens[name];
        if (!screen) throw new Error(`the driver has no screen "${name}"`);
        const params = Object.fromEntries(Object.entries(step.look?.params ?? {}).map(([k, v]) => [k, String(resolveValue(v))]));
        path = screen(viewer, params);
      }
      if (path && html === undefined) {
        const res = await viewer.fetch(path);
        html = await res.text();
        if (!step.do) obs.status = res.status;
      }
      if (html !== undefined) obs.view = viewOf(html);
    } catch (e) {
      obs.error = (e as Error).message;
    }
    const outbox = (await (await this.request('/__oodle/outbox', { method: 'POST' })).json()) as {
      mail: Observation['mail'];
      outbound: { url: string; method: string }[];
    };
    obs.mail = outbox.mail;
    obs.outbound = outbox.outbound.map((o) => ({ host: new URL(o.url).host, method: o.method }));
    return obs;
  }
}

/**
 * Each request to workerd is a new local connection. Under heavy parallel use (many builds verified
 * at once) the OS can run out of ephemeral ports for a moment; waiting and trying again is all it takes.
 */
async function retryConnect<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (attempt >= 30 || !['EADDRNOTAVAIL', 'ECONNRESET', 'ECONNREFUSED', 'EADDRINUSE'].includes(code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 50 + attempt * 50));
    }
  }
}

interface SessionWithStatus extends Session {
  /** The status of the last response, after redirects. */
  last: number;
  /** Its body: what the user sees when the action doesn't land on a named screen. */
  lastBody: string;
}

/** `owner:ada` is the user `ada` with persona `owner`. */
export const idOf = (key: string) => key.slice(key.indexOf(':') + 1);
export const personaOf = (key: string) => key.slice(0, key.indexOf(':'));

function userOf(key: string, f: Fixture) {
  const { name, email, ...data } = f;
  const id = idOf(key);
  return { id, persona: personaOf(key), name, email: email ?? `${id}@example.com`, data };
}

/** Runs scenarios over a few instances of one build. Results come back in the scenarios' order. */
export async function runScenarios(build: LoadedBuild, scenarios: Scenario[], opts: SimOptions = {}): Promise<ScenarioResult[]> {
  const n = Math.max(1, Math.min(opts.parallel ?? 4, scenarios.length));
  const instances = await Promise.all(Array.from({ length: n }, () => Instance.start(build, opts)));
  const results: ScenarioResult[] = new Array(scenarios.length);
  let next = 0;
  try {
    await Promise.all(
      instances.map(async (inst) => {
        while (next < scenarios.length) {
          const i = next++;
          results[i] = await inst.run(scenarios[i] as Scenario);
        }
      }),
    );
  } finally {
    await Promise.all(instances.map((i) => i.dispose()));
  }
  return results;
}
