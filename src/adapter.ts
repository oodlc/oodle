/**
 * Runs an existing HTTP app under the OODLC contract without rewriting it.
 *
 *   // oodle.app.ts
 *   import { httpApp } from 'oodle/adapter';
 *   import { app } from './src/server.ts';
 *   export default httpApp(app, {
 *     effects: { 'POST api.stripe.com/v1/charges': 'payment.charge', 'api.sendgrid.com': 'email.send' },
 *   });
 *
 * The app can be an Express or Connect app, a Koa app, an `http.Server`, a plain
 * `(req, res)` handler, or anything with a `fetch(Request)` method (Hono, itty,
 * Web-standard handlers). Each request goes through the app's own middleware in
 * process: no port is opened and nothing leaves the simulation.
 *
 * While a request runs:
 * - `fetch` calls that match an `effects` rule become `ctx.effects.call(kind, payload)`,
 *   so they are stubbed and recorded like any other external call. Anything else
 *   falls through to the sealed simulation, which refuses and reports it.
 * - Time, `crypto.randomUUID`, random bytes and `Math.random` are deterministic,
 *   so two runs of the same code give the same output and the outcome diff only
 *   shows real changes. Turn this off with `deterministic: false`.
 *
 * `setup(ctx)` runs once per simulated run, before the first request: point
 * module-level stores (a repository, a cache) at `ctx.state` there.
 */
import http from 'node:http';
import net from 'node:net';
import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import type { AppContext, CreateApp, Request, Response, Route } from './contract.ts';

type NodeHandler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;
type FetchHandler = (req: globalThis.Request) => globalThis.Response | Promise<globalThis.Response>;

/** What `httpApp` can drive. A promise is awaited once, e.g. `fastify.ready().then(() => fastify.server)`. */
export type HttpTarget = http.Server | NodeHandler | { callback(): NodeHandler } | { fetch: FetchHandler };

export interface EffectRule {
  /** "METHOD host/path-prefix", "host/path-prefix", a RegExp over the full URL, or a predicate. */
  match: string | RegExp | ((url: URL, method: string) => boolean);
  kind: string;
}

export interface HttpAppOptions {
  /** The app's routes, as `{ method, path }` or "METHOD /path", so Oodle can probe the ones nothing describes. Found automatically for Express and Hono. */
  routes?: (Route | string)[];
  /** Outbound `fetch` calls to route through `ctx.effects`, as `{ "POST api.stripe.com/v1/charges": "payment.charge" }` or a list of rules. The most specific match wins. */
  effects?: Record<string, string> | EffectRule[];
  /** Runs once per simulated run, before the first request. Seed or reset module-level state from `ctx.state` here. */
  setup?: (ctx: AppContext) => void | Promise<void>;
  /** Freeze time and seed randomness while a request runs. Default true. */
  deterministic?: boolean;
}

type Dispatch = (req: Request) => Promise<Response>;

// ── Driving the app ─────────────────────────────────────────────────────────

function nodeRequest(req: Request): { msg: http.IncomingMessage } {
  const msg = new http.IncomingMessage(new net.Socket());
  const body = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const headers: Record<string, string> = { host: 'localhost' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
  Object.assign(msg, { method: req.method, url: req.path, httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1, headers, rawHeaders: Object.entries(headers).flat() });
  if (body !== undefined) msg.push(body);
  msg.push(null);
  return { msg };
}

function decode(text: string, contentType: string | undefined): unknown {
  if (!text) return undefined;
  if (/json/i.test(contentType ?? '') || /^[[{]/.test(text.trim())) {
    try { return JSON.parse(text); } catch { /* not JSON after all */ }
  }
  return text;
}

function lowerHeaders(h: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k, v]) => v !== undefined && k.toLowerCase() !== 'date').map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
}

function nodeDispatch(handler: NodeHandler): Dispatch {
  return (req) => new Promise<Response>((resolve, reject) => {
    const { msg } = nodeRequest(req);
    const res = new http.ServerResponse(msg);
    const chunks: Buffer[] = [];
    const take = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'));
    };
    let done = false;
    // Capture what the app writes instead of sending it anywhere. Headers and status stay on the real ServerResponse.
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      take(chunk, encoding);
      for (const f of [encoding, cb]) if (typeof f === 'function') f();
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (done) return res;
      done = true;
      take(chunk, encoding);
      if (!res.headersSent) res.writeHead(res.statusCode);
      const headers = lowerHeaders(res.getHeaders());
      resolve({ status: res.statusCode, headers, body: decode(Buffer.concat(chunks).toString('utf8'), headers['content-type']) });
      for (const f of [chunk, encoding, cb]) if (typeof f === 'function') f();
      res.emit('finish');
      return res;
    }) as typeof res.end;
    try {
      const out = handler(msg, res);
      if (out && typeof (out as Promise<unknown>).then === 'function') (out as Promise<unknown>).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

function fetchDispatch(handler: FetchHandler): Dispatch {
  return async (req) => {
    const headers = new Headers(req.headers ?? {});
    const hasBody = req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD';
    if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const res = await handler(new globalThis.Request(`http://localhost${req.path}`, {
      method: req.method,
      headers,
      body: hasBody ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined,
    }));
    const out = lowerHeaders(Object.fromEntries(res.headers));
    return { status: res.status, headers: out, body: decode(await res.text(), out['content-type']) };
  };
}

function dispatchFor(target: HttpTarget): { dispatch: Dispatch; routes: Route[] } {
  const t = target as any;
  if (t instanceof http.Server) {
    const [listener] = t.listeners('request') as NodeHandler[];
    if (!listener) throw new Error('httpApp: the http.Server has no request listener. Pass the app itself, e.g. httpApp(app).');
    return { dispatch: nodeDispatch((req, res) => t.emit('request', req, res)), routes: discoverRoutes(listener) };
  }
  if (typeof t === 'function') return { dispatch: nodeDispatch(t), routes: discoverRoutes(t) };
  if (t && typeof t.callback === 'function') return { dispatch: nodeDispatch(t.callback()), routes: discoverRoutes(t) };
  if (t && typeof t.fetch === 'function') return { dispatch: fetchDispatch((r) => t.fetch(r)), routes: discoverRoutes(t) };
  throw new Error('httpApp: pass an Express, Connect or Koa app, an http.Server, a (req, res) handler, or an object with fetch(Request).');
}

/** Routes an Express (4 or 5), Koa router or Hono app declares at the top level. Best effort; pass `routes` for anything else. */
function discoverRoutes(app: any): Route[] {
  const out: Route[] = [];
  const add = (method: string, path: unknown) => {
    for (const p of Array.isArray(path) ? path : [path]) {
      if (typeof p !== 'string' || /[*(]/.test(p)) continue;
      const m = method.toUpperCase();
      if (m === 'ALL' || m === '_ALL' || m === 'HEAD' || m === 'OPTIONS') continue;
      if (!out.some((r) => r.method === m && r.path === p)) out.push({ method: m, path: p });
    }
  };
  const stack = app?._router?.stack ?? app?.router?.stack;
  if (Array.isArray(stack)) {
    for (const layer of stack) if (layer?.route) for (const [m, on] of Object.entries(layer.route.methods ?? {})) if (on) add(m, layer.route.path);
  }
  if (Array.isArray(app?.routes)) for (const r of app.routes) if (r && typeof r.method === 'string') add(r.method, r.path);
  return out;
}

// ── Effects ─────────────────────────────────────────────────────────────────

interface Rule {
  test: (url: URL, method: string) => boolean;
  kind: string;
  /** Longer patterns win over shorter ones. */
  weight: number;
}

function rulesOf(effects: HttpAppOptions['effects']): Rule[] {
  const list: EffectRule[] = Array.isArray(effects) ? effects : Object.entries(effects ?? {}).map(([match, kind]) => ({ match, kind }));
  return list.map(({ match, kind }) => {
    if (typeof match === 'function') return { test: match, kind, weight: 0 };
    if (match instanceof RegExp) return { test: (url: URL) => match.test(url.href), kind, weight: match.source.length };
    const m = /^([A-Z]+)\s+(.+)$/.exec(match.trim());
    const method = m?.[1];
    const prefix = (m?.[2] ?? match).trim().replace(/^https?:\/\//, '');
    return { test: (url: URL, verb: string) => (!method || method === verb) && `${url.host}${url.pathname}`.startsWith(prefix), kind, weight: prefix.length + (method ? 1 : 0) };
  });
}

async function payloadOf(url: URL, input: unknown, init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = Object.fromEntries(url.searchParams);
  let body: unknown = init?.body;
  if (body === undefined && input instanceof globalThis.Request) body = await input.clone().text();
  if (body === undefined || body === null || body === '') return payload;
  if (body instanceof URLSearchParams) return { ...payload, ...Object.fromEntries(body) };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { ...payload, ...Object.fromEntries([...body].map(([k, v]) => [k, String(v)])) };
  const text = typeof body === 'string' ? body : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body as Uint8Array).toString('utf8') : String(body);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...payload, ...parsed } : { ...payload, body: parsed };
  } catch {
    if (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(text)) return { ...payload, ...Object.fromEntries(new URLSearchParams(text)) };
    return { ...payload, body: text };
  }
}

/** A stub's `result` becomes a JSON response. A `$status` key in it sets the HTTP status, e.g. `{ $status: 402, error: { code: card_declined } }`. */
function responseOf(result: unknown): globalThis.Response {
  let status = 200;
  let body = result;
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as any).$status === 'number') {
    const { $status, ...rest } = result as Record<string, unknown>;
    status = $status as number;
    body = rest;
  }
  return new globalThis.Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ── Determinism ─────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and the same sequence for the same seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Clock {
  random: () => number;
  uuids: number;
}

/** Replaces the sources of non-determinism until the returned function is called. */
function freeze(ctx: AppContext, clock: Clock): () => void {
  const RealDate = Date;
  const fixed = RealDate.parse(ctx.now());
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [string]));
      else super(fixed);
    }
    static now() {
      return fixed;
    }
  }
  const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(clock.random() * 256)));
  const uuid = () => `00000000-0000-4000-8000-${(++clock.uuids).toString(16).padStart(12, '0')}`;
  const fill = <T extends ArrayBufferView | null>(view: T): T => {
    if (view) bytes(view.byteLength).copy(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return view;
  };
  const web = globalThis.crypto as any;
  const saved = {
    Date: globalThis.Date,
    random: Math.random,
    webUuid: Object.getOwnPropertyDescriptor(web, 'randomUUID'),
    webFill: Object.getOwnPropertyDescriptor(web, 'getRandomValues'),
    randomUUID: nodeCrypto.randomUUID,
    randomBytes: nodeCrypto.randomBytes,
    randomFillSync: nodeCrypto.randomFillSync,
  };
  globalThis.Date = FrozenDate as DateConstructor;
  Math.random = clock.random;
  Object.defineProperty(web, 'randomUUID', { value: uuid, configurable: true, writable: true });
  Object.defineProperty(web, 'getRandomValues', { value: fill, configurable: true, writable: true });
  Object.assign(nodeCrypto, {
    randomUUID: uuid,
    randomBytes: (n: number, cb?: (err: Error | null, buf: Buffer) => void) => (cb ? void queueMicrotask(() => cb(null, bytes(n))) : bytes(n)),
    randomFillSync: fill,
  });
  syncBuiltinESMExports();
  return () => {
    globalThis.Date = saved.Date;
    Math.random = saved.random;
    for (const [key, d] of [['randomUUID', saved.webUuid], ['getRandomValues', saved.webFill]] as const) {
      if (d) Object.defineProperty(web, key, d);
      else delete web[key];
    }
    Object.assign(nodeCrypto, { randomUUID: saved.randomUUID, randomBytes: saved.randomBytes, randomFillSync: saved.randomFillSync });
    syncBuiltinESMExports();
  };
}

// ── The adapter ─────────────────────────────────────────────────────────────

export function httpApp(target: HttpTarget | Promise<HttpTarget>, options: HttpAppOptions = {}): CreateApp {
  const rules = rulesOf(options.effects);
  const deterministic = options.deterministic ?? true;
  let resolved: Promise<ReturnType<typeof dispatchFor>> | undefined;
  const app = () => (resolved ??= Promise.resolve(target).then(dispatchFor));
  const declared = options.routes?.map((r) => {
    if (typeof r !== 'string') return r;
    const [method, path] = r.trim().split(/\s+/);
    return { method: method.toUpperCase(), path };
  });
  // Route discovery needs the app; a promised target can't be inspected synchronously.
  const discovered = (() => {
    if (declared || (target as any)?.then) return [];
    try { return dispatchFor(target as HttpTarget).routes; } catch { return []; }
  })();

  return (ctx: AppContext) => {
    const clock: Clock = { random: prng(0x0dd1e), uuids: 0 };
    let ready: Promise<void> | undefined;

    return {
      routes: declared ?? discovered,
      async handle(req: Request): Promise<Response> {
        await (ready ??= Promise.resolve(options.setup?.(ctx)).then(() => undefined));
        const { dispatch } = await app();
        const outer = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
          const method = (init?.method ?? (input instanceof globalThis.Request ? input.method : 'GET')).toUpperCase();
          const rule = rules.filter((r) => r.test(url, method)).sort((a, b) => b.weight - a.weight)[0];
          if (!rule) return outer(input, init);
          return responseOf(await ctx.effects.call(rule.kind, await payloadOf(url, input, init)));
        }) as typeof fetch;
        const thaw = deterministic ? freeze(ctx, clock) : () => {};
        try {
          return await dispatch(req);
        } finally {
          thaw();
          globalThis.fetch = outer;
        }
      },
    };
  };
}
