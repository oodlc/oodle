/**
 * @oodle/runtime: everything a generated app may not take from the platform directly. Time, ids,
 * randomness, mail and outbound HTTP all come from `rt(c)`, so the same build answers the same way
 * every time it runs in the simulation, and two builds differ only where they really differ.
 *
 *   import { oodle, rt } from '@oodle/runtime';
 *   const app = new Hono<OodleEnv>();
 *   app.use(oodle());                       // sim control routes, the persona session
 *   app.post('/walks', async (c) => {
 *     const id = rt(c).id('walk');          // walk_1, walk_2… in the simulation
 *     const at = rt(c).now();               // the harness's clock in the simulation
 *     await rt(c).mail.send({ to, subject, text });
 *   });
 *
 * `OODLE_MODE` picks the implementation: `sim` (the harness controls the clock, ids count up per
 * kind, randomness is seeded, mail and outbound requests are captured) or `prod` (the platform's).
 * The determinism check in `oodle verify` fails a build whose own code uses Date.now, new Date(),
 * Math.random, crypto.randomUUID, crypto.getRandomValues or the global fetch.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** A persona user. The `users` table is the runtime's (see USERS_SQL); the simulation seeds it from journey fixtures. */
export interface User {
  id: string;
  persona: string;
  name: string;
  email: string;
  /** Everything else a fixture says about the user (an address, a currency…). */
  data: Record<string, unknown>;
}

export interface OodleBindings {
  OODLE_MODE?: 'sim' | 'prod';
  /** The simulation's seed, for `random()`. */
  OODLE_SEED?: string;
  /** Production mail: a URL that takes `{ from, to, subject, text }` as JSON. Without one, mail is logged. */
  MAIL_URL?: string;
  MAIL_FROM?: string;
  DB?: D1Like;
}

export interface OodleEnv {
  Bindings: OodleBindings;
  Variables: { user?: User };
}

/** The part of D1 the runtime uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> };
  };
}

export interface Runtime {
  now(): Date;
  id(kind: string): string;
  random(): number;
  mail: { send(mail: Mail): Promise<void> };
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  log(event: string, data?: Record<string, unknown>): void;
  /** The signed-in persona user, if any. */
  user(): User | undefined;
}

/** The table persona users live in. The template's first migration creates it. */
export const USERS_SQL =
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, persona TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')";

export const SESSION_COOKIE = 'oodle_user';
export const SIM_START = '2026-01-01T00:00:00.000Z';

// ── The simulation's state ──────────────────────────────────────────────────
// One Worker isolate serves one scenario at a time; the harness resets this between scenarios.

interface SimState {
  clock: number;
  counters: Map<string, number>;
  seed: number;
  rand: () => number;
  mail: Mail[];
  outbound: { url: string; method: string }[];
}

let sim: SimState = fresh(0, Date.parse(SIM_START));

function fresh(seed: number, clock: number): SimState {
  return { clock, counters: new Map(), seed, rand: mulberry32(seed), mail: [], outbound: [] };
}

/** A small seeded PRNG: the same seed gives the same sequence. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isSim = (c: Context<OodleEnv>) => c.env?.OODLE_MODE === 'sim';

export function rt(c: Context<OodleEnv>): Runtime {
  return isSim(c) ? simRuntime(c) : prodRuntime(c);
}

function simRuntime(c: Context<OodleEnv>): Runtime {
  return {
    now: () => new Date(sim.clock),
    id: (kind) => {
      const n = (sim.counters.get(kind) ?? 0) + 1;
      sim.counters.set(kind, n);
      return `${kind}_${n}`;
    },
    random: () => sim.rand(),
    mail: {
      send: async (mail) => {
        sim.mail.push({ to: mail.to, subject: mail.subject, text: mail.text });
      },
    },
    fetch: async (input, init) => {
      const req = new Request(input, init);
      sim.outbound.push({ url: req.url, method: req.method });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    log: () => {},
    user: () => c.get('user'),
  };
}

function prodRuntime(c: Context<OodleEnv>): Runtime {
  return {
    now: () => new Date(),
    id: (kind) => `${kind}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
    mail: {
      send: async (mail) => {
        if (!c.env?.MAIL_URL) {
          console.log(JSON.stringify({ event: 'mail', to: mail.to, subject: mail.subject }));
          return;
        }
        const res = await fetch(c.env.MAIL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: c.env.MAIL_FROM, ...mail }),
        });
        if (!res.ok) throw new Error(`mail failed: ${res.status}`);
      },
    },
    fetch: (input, init) => fetch(input, init),
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
    user: () => c.get('user'),
  };
}

/**
 * The runtime's middleware. In every mode it reads the persona session cookie and loads the user.
 * In the simulation only, it answers the harness's routes under `/__oodle/` (they are 404 in prod):
 *
 * - `POST /__oodle/reset {seed, clock, sql?, users?}`: a new scenario: counters, PRNG, outbox and
 *   clock start over; with `sql`, every table is dropped and the statements (the build's
 *   migrations) run; `users` are seeded. One request, so a scenario starts cheaply.
 * - `POST /__oodle/clock {at}`: the time the next requests see.
 * - `POST /__oodle/users [User…]`: seeds persona users.
 * - `GET /__oodle/login?user=ada`: signs in as a persona user.
 * - `POST /__oodle/outbox`: returns, and empties, the mail and outbound requests captured so far.
 *
 * In the simulation, every response also carries what its request captured, in the
 * `x-oodle-outbox` header, so the harness rarely needs to ask.
 */
export function oodle(): MiddlewareHandler<OodleEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/__oodle/')) {
      if (!isSim(c)) return c.notFound();
      return control(c, path.slice('/__oodle/'.length));
    }
    const id = getCookie(c, SESSION_COOKIE);
    if (id && c.env?.DB) {
      const row = await c.env.DB.prepare('SELECT id, persona, name, email, data FROM users WHERE id = ?')
        .bind(id)
        .first<Omit<User, 'data'> & { data: string }>();
      if (row) c.set('user', { ...row, data: JSON.parse(row.data || '{}') });
    }
    await next();
  };
}

export const OUTBOX_HEADER = 'x-oodle-outbox';

async function seedUsers(db: D1Like, users: User[]) {
  await db.prepare(USERS_SQL).bind().run();
  for (const u of users) {
    await db.prepare('INSERT INTO users (id, persona, name, email, data) VALUES (?, ?, ?, ?, ?)').bind(u.id, u.persona, u.name, u.email, JSON.stringify(u.data ?? {})).run();
  }
}

async function control(c: Context<OodleEnv>, what: string) {
  switch (`${c.req.method} ${what}`) {
    case 'POST reset': {
      const { seed = 0, clock = SIM_START, sql, users } = await c.req.json<{ seed?: number; clock?: string; sql?: string[]; users?: User[] }>();
      sim = fresh(seed, Date.parse(clock));
      if (sql && c.env.DB) {
        const db = c.env.DB;
        // Newest first, so a table is dropped before the tables its foreign keys point at.
        const { results } = await db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY rowid DESC")
          .bind()
          .all<{ name: string }>();
        for (const t of results) await db.prepare(`DROP TABLE IF EXISTS "${t.name}"`).bind().run();
        for (const [i, s] of sql.entries()) {
          try {
            await db.prepare(s).bind().run();
          } catch (e) {
            return c.json({ error: `statement ${i + 1} failed: ${(e as Error).message}`, statement: s }, 500);
          }
        }
      }
      if (users?.length && c.env.DB) await seedUsers(c.env.DB, users);
      return c.body(null, 204);
    }
    case 'POST clock': {
      const { at } = await c.req.json<{ at: string }>();
      const t = Date.parse(at);
      if (Number.isNaN(t)) return c.json({ error: `not a time: ${at}` }, 400);
      sim.clock = t;
      return c.body(null, 204);
    }
    case 'POST users': {
      if (!c.env.DB) return c.json({ error: 'no DB binding' }, 500);
      await seedUsers(c.env.DB, await c.req.json<User[]>());
      return c.body(null, 204);
    }
    case 'GET login': {
      const user = c.req.query('user');
      if (!user) return c.json({ error: 'login needs ?user=' }, 400);
      setCookie(c, SESSION_COOKIE, user, { path: '/', httpOnly: true, sameSite: 'Lax' });
      return c.body(null, 204);
    }
    case 'POST outbox': {
      const out = { mail: sim.mail, outbound: sim.outbound };
      sim.mail = [];
      sim.outbound = [];
      return c.json(out);
    }
    default:
      return c.notFound();
  }
}

export * from './driver.ts';
