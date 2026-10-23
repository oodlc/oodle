/**
 * @oodlc/oodle/workers: runs a Cloudflare Worker in process, in Oodle's sealed simulation. No
 * workerd, no Miniflare, no port: the Worker's own fetch handler gets a Request, an `env` built
 * from wrangler.jsonc (or .json, or .toml) and an ExecutionContext, and Oodle records what it does.
 *
 *   // oodle.app.mts
 *   import { workerApp } from '@oodlc/oodle/workers';
 *   export default await workerApp(() => import('./src/index.ts'), {
 *     wrangler: new URL('./wrangler.jsonc', import.meta.url),
 *     routes: ['GET /', 'POST /signup'],
 *   });
 *
 * What the Worker gets, binding by binding (see docs/decisions/0017):
 * - `vars`, and anything under `env` here (test values for secrets).
 * - D1: the simulated SQLite database (`database: { engine: sqlite }` in oodlc/config.yaml),
 *   migrations applied, seeded from `given.db`, every write recorded.
 * - KV: an in-memory namespace in `given.state[<binding>]`, so a run seeds it and constraints see it.
 * - Static assets: served from the assets directory before the Worker runs, as Cloudflare does.
 * - Everything else (send_email, queues, services, R2, analytics, AI, …): each method call is an
 *   effect named `<binding>.<method>`. Sends are recorded; calls that answer need a stub.
 * - `cloudflare:workers` (env, WorkerEntrypoint), `cloudflare:email`, HTMLRewriter (through
 *   html-rewriter-wasm, installed next to Oodle), `caches`, and `crypto.subtle.timingSafeEqual`.
 * - Text, Data and CompiledWasm modules, from Wrangler's defaults and the project's `rules`.
 *
 * `ctx.waitUntil` work finishes before the response is checked, so what it does counts.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nodeCrypto from 'node:crypto';
import { httpApp, type HttpAppOptions } from './adapter.ts';
import type { AppContext, CreateApp } from './contract.ts';

export interface WorkerAppOptions extends Omit<HttpAppOptions, 'setup'> {
  /** The Wrangler config: wrangler.jsonc, .json or .toml. A relative path resolves from the current directory. Default: the first one found there. */
  wrangler?: string | URL;
  /** Values for `env`: secrets the Worker reads, test values for vars, or a stand-in for a binding. They win over the Wrangler config. */
  env?: Record<string, unknown>;
  /** Runs once per simulated run, before the first request, with the run's context and the Worker's env. */
  setup?: (ctx: AppContext, env: Record<string, unknown>) => void | Promise<void>;
}

/** What the module hooks and `cloudflare:workers` read: the env of the run in progress. */
const SIM_KEY = Symbol.for('oodle.workers');
/** The simulated SQLite database, published by the runner (src/sqlite.ts). */
const SQLITE_KEY = Symbol.for('oodle.sqlite');
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workers-hooks.mjs');

type Env = Record<string, unknown>;
type Wrangler = Record<string, any>;

// ── The Wrangler config ─────────────────────────────────────────────────────

/** JSON with comments and trailing commas, as Wrangler reads wrangler.jsonc. */
function parseJsonc(text: string): Wrangler {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      out += m ? m[0] : c;
      i += (m?.[0].length ?? 1) - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1 || text.length;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The TOML Wrangler configs use: tables, arrays of tables, strings, numbers, booleans, arrays and inline tables. */
export function parseToml(text: string): Wrangler {
  const root: Wrangler = {};
  let table = root;
  let i = 0;
  const ws = () => { while (i < text.length && /[ \t\r\n]|#/.test(text[i])) { if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++; else i++; } };
  const inline = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      inline();
      if (text[i] === '"' || text[i] === "'") parts.push(str() as string);
      else { const m = /[A-Za-z0-9_-]+/y; m.lastIndex = i; const k = m.exec(text)![0]; i += k.length; parts.push(k); }
      inline();
      if (text[i] !== '.') return parts;
      i++;
    }
  };
  const str = (): string => {
    const q = text[i];
    const triple = text.startsWith(q.repeat(3), i);
    const close = triple ? q.repeat(3) : q;
    i += close.length;
    if (triple && text[i] === '\n') i++;
    let s = '';
    while (!text.startsWith(close, i)) {
      if (q === '"' && text[i] === '\\') {
        const e = text[++i];
        s += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' } as Record<string, string>)[e] ?? (e === 'u' ? String.fromCharCode(parseInt(text.slice(i + 1, (i += 4) + 1), 16)) : e);
        i++;
      } else s += text[i++];
    }
    i += close.length;
    return s;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (text[i] === ']') { i++; return arr; }
        arr.push(value());
        ws();
        if (text[i] === ',') i++;
      }
    }
    if (c === '{') {
      i++;
      const obj: Wrangler = {};
      for (;;) {
        inline();
        if (text[i] === '}') { i++; return obj; }
        const k = key();
        inline();
        i++; // =
        setPath(obj, k, value());
        inline();
        if (text[i] === ',') i++;
      }
    }
    const m = /[^\s,\]}#]+/y;
    m.lastIndex = i;
    const raw = m.exec(text)![0];
    i += raw.length;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    const n = Number(raw.replace(/_/g, ''));
    return Number.isNaN(n) ? raw : n;
  };
  const setPath = (obj: Wrangler, path: string[], v: unknown) => {
    let o = obj;
    for (const p of path.slice(0, -1)) o = (o[p] ??= {});
    o[path.at(-1)!] = v;
  };
  const tableAt = (path: string[], array: boolean) => {
    let o = root;
    for (const [n, p] of path.entries()) {
      const last = n === path.length - 1;
      if (last && array) {
        const list = (o[p] ??= []);
        list.push({});
        return list.at(-1);
      }
      o = Array.isArray(o[p]) ? o[p].at(-1) : (o[p] ??= {});
    }
    return o;
  };
  for (;;) {
    ws();
    if (i >= text.length) return root;
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const path = key();
      i += array ? 2 : 1;
      table = tableAt(path, array);
      continue;
    }
    const k = key();
    inline();
    i++; // =
    setPath(table, k, value());
  }
}

const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/** Reads the Wrangler config, and where it lives: paths in it are relative to that folder. */
export function readWrangler(where?: string | URL): { config: Wrangler; dir: string; file: string } {
  const file = where instanceof URL ? fileURLToPath(where) : where ? resolve(where) : WRANGLER_FILES.map((f) => resolve(f)).find((f) => existsSync(f));
  if (!file || !existsSync(file)) throw new Error(`workerApp: no Wrangler config${file ? ` at ${file}` : ` (${WRANGLER_FILES.join(', ')}) in ${process.cwd()}`}. Pass wrangler: new URL('./wrangler.jsonc', import.meta.url).`);
  const text = readFileSync(file, 'utf8');
  return { config: file.endsWith('.toml') ? parseToml(text) : parseJsonc(text), dir: dirname(file), file };
}

// ── Modules and globals ─────────────────────────────────────────────────────

/** The `cloudflare:` modules, shared by import (src/workers-hooks.mjs) and require. */
function cloudflareModules(sim: () => Record<string, any>): Record<string, Record<string, unknown>> {
  const env = new Proxy({}, {
    get: (_, k) => sim().env?.[k],
    has: (_, k) => k in (sim().env ?? {}),
    ownKeys: () => Reflect.ownKeys(sim().env ?? {}),
    getOwnPropertyDescriptor: (_, k) => (k in (sim().env ?? {}) ? { value: sim().env[k], enumerable: true, configurable: true } : undefined),
  });
  class Entrypoint {
    constructor(readonly ctx: unknown, readonly env: Env) {}
  }
  const mod = (o: Record<string, unknown>) => ({ __esModule: true, ...o, default: o });
  return {
    workers: mod({ env, WorkerEntrypoint: class WorkerEntrypoint extends Entrypoint {}, DurableObject: class DurableObject extends Entrypoint {}, WorkflowEntrypoint: class WorkflowEntrypoint extends Entrypoint {}, RpcTarget: class RpcTarget {}, waitUntil: (p: Promise<unknown>) => sim().waitUntil?.(p) }),
    email: mod({ EmailMessage: class EmailMessage { constructor(readonly from: string, readonly to: string, readonly raw: unknown) {} } }),
    sockets: mod({ connect: (address: unknown) => { throw new Error(`cloudflare:sockets connect(${JSON.stringify(address)}) is refused: Oodle runs Workers in a sealed simulation`); } }),
    workflows: mod({ NonRetryableError: class NonRetryableError extends Error {} }),
  };
}

let hooked = false;

/** Registers the module hooks once, for import and for require, with the extensions Wrangler's rules turn into modules. */
function hook(config: Wrangler) {
  if (hooked) return;
  hooked = true;
  const sim = () => ((globalThis as Record<symbol, any>)[SIM_KEY] ??= {});
  const modules = (sim().modules = cloudflareModules(sim));
  const kinds = { text: ['.txt', '.html', '.sql'], data: ['.bin'], wasm: ['.wasm'] };
  for (const rule of config.rules ?? []) {
    const kind = ({ Text: 'text', Data: 'data', CompiledWasm: 'wasm' } as Record<string, keyof typeof kinds>)[rule.type];
    if (!kind) continue;
    for (const glob of rule.globs ?? []) {
      const ext = /\*(\.[\w.]+)$/.exec(glob)?.[1];
      if (ext && !kinds[kind].includes(ext)) kinds[kind].push(ext);
    }
  }
  register(pathToFileURL(HOOKS).href, { data: { kinds } });

  // A project without "type": "module" loads its TypeScript through require (tsx), which the hooks above never see.
  const Module = createRequire(import.meta.url)('node:module') as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request.startsWith('cloudflare:')) {
      const m = modules[request.slice('cloudflare:'.length)];
      if (!m) throw new Error(`${request} is not simulated by Oodle`);
      return m;
    }
    return load.call(this, request, ...rest);
  };
  const extensions = createRequire(import.meta.url).extensions as unknown as Record<string, (m: { exports: unknown }, file: string) => void>;
  for (const ext of kinds.text) extensions[ext] = (m, file) => void (m.exports = readFileSync(file, 'utf8'));
  for (const ext of kinds.data) extensions[ext] = (m, file) => void (m.exports = new Uint8Array(readFileSync(file)).buffer);
  for (const ext of kinds.wasm) extensions[ext] = (m, file) => void (m.exports = new WebAssembly.Module(readFileSync(file)));
}

/** HTMLRewriter as Workers have it, on lol-html compiled to WebAssembly (html-rewriter-wasm). */
class HTMLRewriter {
  private handlers: (['on', string, object] | ['doc', object])[] = [];

  on(selector: string, handlers: object): this {
    this.handlers.push(['on', selector, handlers]);
    return this;
  }

  onDocument(handlers: object): this {
    this.handlers.push(['doc', handlers]);
    return this;
  }

  transform(response: globalThis.Response): globalThis.Response {
    const Raw = rewriterEngine();
    const handlers = this.handlers;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const raw = new Raw((chunk: Uint8Array) => controller.enqueue(chunk.slice()));
        for (const h of handlers) h[0] === 'on' ? raw.on(h[1], h[2]) : raw.onDocument(h[1]);
        try {
          if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) await raw.write(chunk);
          await raw.end();
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          raw.free();
        }
      },
    });
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new globalThis.Response(body, { status: response.status, statusText: response.statusText, headers });
  }
}

function rewriterEngine(): any {
  for (const base of [join(process.cwd(), 'package.json'), import.meta.url]) {
    try {
      return createRequire(base)('html-rewriter-wasm').HTMLRewriter;
    } catch { /* try the next one */ }
  }
  throw new Error('HTMLRewriter needs html-rewriter-wasm, which is not installed. Install it next to Oodle: npm i -D html-rewriter-wasm (lol-html compiled to WebAssembly, as Cloudflare runs it).');
}

let globalsInstalled = false;

/** What a Worker finds on globalThis that Node doesn't have. Only what's missing is added. */
function installGlobals() {
  if (globalsInstalled) return;
  globalsInstalled = true;
  const g = globalThis as Record<string, any>;
  g.HTMLRewriter ??= HTMLRewriter;
  // A cache that never hits: every run starts cold, so nothing carries over between runs.
  g.caches ??= { default: { match: async () => undefined, put: async () => {}, delete: async () => false }, open: async () => g.caches.default };
  const subtle = g.crypto?.subtle;
  if (subtle && !subtle.timingSafeEqual) {
    Object.defineProperty(Object.getPrototypeOf(subtle), 'timingSafeEqual', {
      value: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => {
        const x = Buffer.from(ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a));
        const y = Buffer.from(ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));
        if (x.length !== y.length) throw new TypeError('Input buffers must have the same byte length');
        return nodeCrypto.timingSafeEqual(x, y);
      },
      configurable: true,
      writable: true,
    });
  }
}

// ── Bindings ────────────────────────────────────────────────────────────────

/** A value as an effect payload: plain data, with bytes and streams named rather than copied. */
function payloadOf(args: unknown[]): Record<string, unknown> {
  const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x) => {
    if (x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return `<${x.byteLength} bytes>`;
    if (x instanceof ReadableStream) return '<stream>';
    if (typeof x === 'bigint') return String(x);
    return x;
  }) ?? 'null');
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const o = args[0] as Record<string, unknown>;
    // An object with its data in fields of its own (an EmailMessage, a queue body) is its fields.
    return plain(Object.fromEntries(Object.entries(o))) as Record<string, unknown>;
  }
  return { args: plain(args) };
}

/** Methods that only send: recorded, never answered, so they need no stub. */
const SENDS = new Set(['send', 'sendBatch', 'writeDataPoint', 'put', 'delete', 'enqueue']);

/** A binding Oodle doesn't model: each method call becomes the effect `<binding>.<method>`. */
function effectBinding(ctx: AppContext, name: string): unknown {
  return new Proxy({}, {
    get(_, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      const kind = `${name}.${method}`;
      if (method === 'fetch') {
        return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
          const req = new globalThis.Request(input, init);
          const text = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
          let body: unknown = text;
          try { body = text ? JSON.parse(text) : undefined; } catch { /* stays text */ }
          const result = (await ctx.effects.call(kind, { method: req.method, url: req.url, ...(body === undefined ? {} : { body }) })) as Record<string, unknown> | null;
          const { $status, ...rest } = result && typeof result === 'object' ? result : { $status: 200 };
          return new globalThis.Response(JSON.stringify(rest), { status: Number($status ?? 200), headers: { 'content-type': 'application/json' } });
        };
      }
      if (SENDS.has(method)) return async (...args: unknown[]) => void ctx.effects.emit(kind, payloadOf(args));
      return async (...args: unknown[]) => ctx.effects.call(kind, payloadOf(args));
    },
  });
}

/** A KV namespace kept in `ctx.state[name]`: `given.state` seeds it, and constraints see it in `state`. */
function kvBinding(ctx: AppContext, name: string) {
  const store = (): Record<string, string> => (ctx.state[name] ??= {});
  const read = (v: string | undefined, type?: string | { type?: string }) => {
    if (v === undefined) return null;
    const t = typeof type === 'string' ? type : type?.type;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (t === 'json') return JSON.parse(text);
    if (t === 'arrayBuffer') return new TextEncoder().encode(text).buffer;
    if (t === 'stream') return new globalThis.Response(text).body;
    return text;
  };
  return {
    get: async (key: string, type?: string | { type?: string }) => read(store()[key], type),
    getWithMetadata: async (key: string, type?: string | { type?: string }) => ({ value: read(store()[key], type), metadata: null }),
    put: async (key: string, value: unknown) => {
      store()[key] = typeof value === 'string' ? value : value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? Buffer.from(value as ArrayBuffer).toString('utf8') : value instanceof globalThis.ReadableStream ? await new globalThis.Response(value).text() : String(value);
    },
    delete: async (key: string) => void delete store()[key],
    list: async (opts: { prefix?: string; limit?: number } = {}) => {
      const keys = Object.keys(store()).filter((k) => k.startsWith(opts.prefix ?? '')).sort().slice(0, opts.limit ?? 1000);
      return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: '' };
    },
  };
}

/** The D1 binding: the database the runner opened. Without one, a clear error on first use. */
function d1Binding(name: string): unknown {
  const db = (globalThis as Record<symbol, any>)[SQLITE_KEY];
  if (db) return db.d1();
  return new Proxy({}, {
    get: (_, k) => (k === 'then' ? undefined : () => {
      throw new Error(`env.${name} is a D1 database: add database: { engine: sqlite, schema: <migrations folder> } to oodlc/config.yaml, and Oodle runs it in process`);
    }),
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

/** Static assets as Cloudflare serves them: the file, then .html, then index.html, then the not-found handling. */
function assetServer(dir: string, config: Wrangler['assets']) {
  const file = (path: string) => {
    const abs = join(dir, decodeURIComponent(path));
    if (!abs.startsWith(dir + sep) && abs !== dir) return undefined;
    return existsSync(abs) && statSync(abs).isFile() ? abs : undefined;
  };
  const serve = (abs: string, status = 200) => new globalThis.Response(readFileSync(abs), { status, headers: { 'content-type': TYPES[extname(abs)] ?? 'application/octet-stream' } });
  const find = (path: string): globalThis.Response | null => {
    const clean = path.replace(/\/+$/, '');
    const hit = file(path) ?? file(`${clean}.html`) ?? file(`${clean}/index.html`);
    return hit ? serve(hit) : null;
  };
  return {
    find,
    async fetch(input: string | URL | globalThis.Request): Promise<globalThis.Response> {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://localhost');
      const found = find(url.pathname);
      if (found) return found;
      if (config?.not_found_handling === 'single-page-application' && file('/index.html')) return serve(file('/index.html')!);
      if (config?.not_found_handling === '404-page' && file('/404.html')) return serve(file('/404.html')!, 404);
      return new globalThis.Response('Not Found', { status: 404 });
    },
  };
}

/** Wrangler keys whose entries are bindings Oodle doesn't model, and the field that names each. */
const EFFECT_BINDINGS: [string, string][] = [
  ['send_email', 'name'], ['queues.producers', 'binding'], ['services', 'binding'], ['r2_buckets', 'binding'],
  ['analytics_engine_datasets', 'binding'], ['durable_objects.bindings', 'name'], ['vectorize', 'binding'],
  ['hyperdrive', 'binding'], ['workflows', 'binding'], ['dispatch_namespaces', 'binding'], ['mtls_certificates', 'binding'],
];

function buildEnv(ctx: AppContext, config: Wrangler, dir: string, overrides: Env): Env {
  const env: Env = { ...(config.vars ?? {}) };
  for (const [path, field] of EFFECT_BINDINGS) {
    const list = path.split('.').reduce<any>((o, k) => o?.[k], config);
    for (const b of Array.isArray(list) ? list : []) if (b?.[field]) env[b[field]] = effectBinding(ctx, b[field]);
  }
  for (const single of ['ai', 'browser', 'images']) if (config[single]?.binding) env[config[single].binding] = effectBinding(ctx, config[single].binding);
  if (config.version_metadata?.binding) env[config.version_metadata.binding] = { id: 'oodle', tag: '', timestamp: '2026-01-01T00:00:00.000Z' };
  for (const kv of config.kv_namespaces ?? []) if (kv?.binding) env[kv.binding] = kvBinding(ctx, kv.binding);
  for (const d1 of config.d1_databases ?? []) if (d1?.binding) env[d1.binding] = d1Binding(d1.binding);
  if (config.assets?.binding && config.assets.directory) env[config.assets.binding] = assetServer(resolve(dir, config.assets.directory), config.assets);
  return { ...env, ...overrides };
}

// ── The adapter ─────────────────────────────────────────────────────────────

/** A Worker's default export: an object with fetch(request, env, ctx), or a WorkerEntrypoint class. */
type Worker = { fetch?: (req: globalThis.Request, env: Env, ctx: unknown) => globalThis.Response | Promise<globalThis.Response>; routes?: unknown } | (new (ctx: unknown, env: Env) => { fetch(req: globalThis.Request): globalThis.Response | Promise<globalThis.Response> });

/**
 * Runs a Cloudflare Worker for Oodle. `load` imports the Worker's entry module, after the module hooks
 * are in place, so its `cloudflare:` and non-JavaScript imports resolve: `() => import('./src/index.ts')`.
 */
export async function workerApp(load: () => Promise<{ default?: unknown }> | { default?: unknown }, options: WorkerAppOptions = {}): Promise<CreateApp> {
  const { config, dir } = readWrangler(options.wrangler);
  hook(config);
  installGlobals();
  const worker = (await load()).default as Worker;
  if (!worker || (typeof worker !== 'function' && typeof worker.fetch !== 'function')) {
    throw new Error('workerApp: the module has no default export with fetch(request, env, ctx). Export the Worker as the default, or a class extending WorkerEntrypoint.');
  }
  const assets = config.assets?.directory && !config.assets.run_worker_first ? assetServer(resolve(dir, config.assets.directory), config.assets) : undefined;
  const sim = () => ((globalThis as Record<symbol, any>)[SIM_KEY] ??= {});

  const target = {
    // A Hono app's routes come along, so Oodle can find the ones nothing describes.
    routes: typeof worker === 'function' ? undefined : worker.routes,
    async fetch(req: globalThis.Request): Promise<globalThis.Response> {
      const served = assets?.find(new URL(req.url).pathname);
      if (served && (req.method === 'GET' || req.method === 'HEAD')) return served;
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(Promise.resolve(p)), passThroughOnException: () => {}, props: {} };
      sim().waitUntil = ctx.waitUntil;
      const env = sim().env as Env;
      const res = typeof worker === 'function' ? await new worker(ctx, env).fetch(req) : await worker.fetch!(req, env, ctx);
      // Work handed to waitUntil happens before the run is judged, so its effects and writes count.
      for (let n = 0; n < waits.length; n++) await waits[n].catch(() => {});
      return res;
    },
  };

  return httpApp(target as never, {
    ...options,
    async setup(ctx) {
      const env = buildEnv(ctx, config, dir, options.env ?? {});
      sim().env = env;
      await options.setup?.(ctx, env);
    },
  });
}
