/**
 * Runs a Next.js App Router app under the OODLC contract, without a build or a server.
 *
 *   // oodle.app.ts
 *   import { nextApp } from '@oodlc/oodle/next';
 *   export default nextApp({
 *     dir: import.meta.dirname,
 *     effects: { 'POST api.stripe.com/v1/charges': 'payment.charge' },
 *   });
 *
 * Each request goes through `middleware.ts` (or `proxy.ts`) when its matcher
 * applies, then to the `app/**\/route.ts` handler for the path. Handlers run
 * inside Next's own route module, from the project's own `next` package, so
 * `cookies()`, `headers()`, `redirect()`, `notFound()` and `dynamic` behave as
 * they do in Next. Everything `httpApp` does still applies: outbound calls named
 * in `effects` are stubbed, the rest is sealed, and time and randomness are
 * deterministic.
 *
 * Pages, server components and server actions aren't run: Oodle checks what a
 * caller sees over HTTP, and route handlers are that surface. Supports Next 15
 * and 16. See docs/decisions/0008.
 */
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { httpApp, type HttpAppOptions } from './adapter.js';
import type { AppContext, CreateApp, Route } from './contract.js';
import { findRoutes, firstExisting, type RouteFile } from './next-routes.js';

export interface NextAppOptions extends Omit<HttpAppOptions, 'routes'> {
  /** The Next.js project root: the folder with next.config and app/ (or src/app/). Default: the current directory. */
  dir?: string;
}

const SUPPORTED = [15, 16];

// ── Matching a path to a route file ─────────────────────────────────────────

function match(route: RouteFile, pathname: string): Record<string, string | string[]> | null {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const params: Record<string, string | string[]> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i];
    if ('text' in seg) {
      if (parts[i] !== seg.text) return null;
    } else if (seg.kind === 'one') {
      if (parts[i] === undefined) return null;
      params[seg.param] = parts[i];
    } else {
      const rest = parts.slice(i);
      if (!rest.length && seg.kind === 'all') return null;
      if (rest.length) params[seg.param] = rest;
      return params;
    }
  }
  return parts.length === route.segments.length ? params : null;
}

/** Routes in Oodle's form: [id] and [...slug] become :id and :slug, and an optional catch-all also lists its base path. */
function oodleRoutes(routes: RouteFile[]): Route[] {
  return routes.flatMap((r) => {
    const path = (segs: RouteFile['segments']) => `/${segs.map((s) => ('text' in s ? s.text : `:${s.param}`)).join('/')}`;
    const last = r.segments.at(-1);
    const paths = last && 'param' in last && last.kind === 'optional' ? [path(r.segments.slice(0, -1)), path(r.segments)] : [path(r.segments)];
    return paths.flatMap((p) => r.methods.filter((m) => m !== 'HEAD' && m !== 'OPTIONS').map((method) => ({ method, path: p })));
  });
}

// ── Next itself, from the project ───────────────────────────────────────────

interface NextRuntime {
  version: string;
  NextRequest: new (input: URL | string, init?: RequestInit) => globalThis.Request & { nextUrl: URL };
  AppRouteRouteModule: new (opts: Record<string, unknown>) => { handle(req: unknown, context: unknown): Promise<globalThis.Response> };
  matchers?: (matcher: unknown) => (pathname: string, req: unknown, query: unknown) => boolean;
  loadEnv(dir: string): void;
}

function nextRuntime(dir: string): NextRuntime {
  const fromProject = createRequire(join(dir, 'package.json'));
  let pkgPath: string;
  try {
    pkgPath = fromProject.resolve('next/package.json');
  } catch {
    throw new Error(`nextApp: next isn't installed in ${dir}. Install the project's dependencies first.`);
  }
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string;
  if (!SUPPORTED.includes(Number(version.split('.')[0]))) {
    throw new Error(`nextApp: Next ${version} isn't supported yet. Oodle runs Next ${SUPPORTED.join(' and ')}.`);
  }
  // Next's own dependencies (@next/env) resolve from next, not from the project: pnpm doesn't hoist them.
  const fromNext = createRequire(pkgPath);
  // Sets the globals Next's server sets up before any of its modules load, such as AsyncLocalStorage.
  fromNext('./dist/server/node-environment');
  // Next projects set "jsx": "preserve" and let Next compile JSX; tsx then emits React.createElement, which needs React in scope.
  if (!('React' in globalThis)) {
    try { (globalThis as Record<string, unknown>).React = fromProject('react'); } catch { /* no React: no JSX to run */ }
  }
  const { NextRequest } = fromNext('./server.js');
  const { AppRouteRouteModule } = fromNext('./dist/server/route-modules/app-route/module.compiled');
  let matchers: NextRuntime['matchers'];
  try {
    const { getMiddlewareMatchers } = fromNext('./dist/build/analysis/get-page-static-info');
    const { getMiddlewareRouteMatcher } = fromNext('./dist/shared/lib/router/utils/middleware-route-matcher');
    matchers = (matcher) => getMiddlewareRouteMatcher(getMiddlewareMatchers(matcher, {}));
  } catch { /* without Next's matcher compiler, middleware runs on every request */ }
  const { loadEnvConfig } = fromNext('@next/env');
  return {
    version,
    NextRequest,
    AppRouteRouteModule,
    matchers,
    loadEnv(projectDir) {
      // Next's test mode: .env.test.local, .env.test and .env, never .env.local, so a laptop and CI see the same values.
      const before = process.env.NODE_ENV;
      // Next resets process.env to what it saw first. The simulated database's URL (src/database.ts) outranks that and .env files.
      const sim = process.env.OODLE_DATABASE_URL;
      const pointed = sim ? Object.keys(process.env).filter((k) => process.env[k] === sim) : [];
      (process.env as Record<string, string>).NODE_ENV = 'test';
      try {
        loadEnvConfig(projectDir, false, { info: () => {}, error: () => {} }, true);
      } finally {
        if (before === undefined) delete process.env.NODE_ENV;
        else (process.env as Record<string, string>).NODE_ENV = before;
        for (const k of pointed) process.env[k] = sim;
      }
    },
  };
}

// From src/ or dist/ alike: the package ships src/.
const SERVER_ONLY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server-only.cjs');

/**
 * Next's bundler resolves `server-only` to an empty module on the server. Do the same for require and import,
 * from the moment this module loads: an app's oodle.app.ts may import its own server-only modules before nextApp() runs.
 */
function aliasServerOnly(): void {
  const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; registerHooks?: (hooks: unknown) => void };
  if ((globalThis as { __oodleServerOnly?: true }).__oodleServerOnly) return;
  (globalThis as { __oodleServerOnly?: true }).__oodleServerOnly = true;
  if (M.registerHooks) {
    // Node 22.15+: one hook for require and import alike.
    const url = pathToFileURL(SERVER_ONLY).href;
    M.registerHooks({
      resolve: (specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) =>
        specifier === 'server-only' ? { url, shortCircuit: true } : next(specifier, context),
    });
    return;
  }
  const original = M._resolveFilename;
  M._resolveFilename = (request: string, ...rest: unknown[]) => (request === 'server-only' ? SERVER_ONLY : original.call(Module, request, ...rest));
}
aliasServerOnly();

/** Loads a module of the project's through the tsx hooks Oodle registered: require first (so CommonJS exports come through), import for ESM-only code. */
async function load(file: string): Promise<Record<string, any>> {
  try {
    return createRequire(file)(file);
  } catch (err) {
    if (!/ERR_REQUIRE_(ESM|ASYNC_MODULE)/.test((err as NodeJS.ErrnoException).code ?? '')) throw err;
    return import(pathToFileURL(file).href);
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────

/** What a Next app's middleware asked for. Mirrors how Next reads the x-middleware-* headers. */
function middlewareOutcome(res: globalThis.Response): { next: true; rewrite?: string; headers?: Headers; carry: Headers } | { next: false; response: globalThis.Response } {
  const h = res.headers;
  if (!h.has('x-middleware-next') && !h.has('x-middleware-rewrite')) return { next: false, response: res };
  let headers: Headers | undefined;
  const override = h.get('x-middleware-override-headers');
  if (override !== null) {
    headers = new Headers();
    for (const name of override.split(',').map((s) => s.trim()).filter(Boolean)) {
      const v = h.get(`x-middleware-request-${name}`);
      if (v !== null) headers.set(name, v);
    }
  }
  const carry = new Headers();
  for (const [k, v] of h) if (!k.startsWith('x-middleware-') && k !== 'set-cookie') carry.append(k, v);
  for (const c of h.getSetCookie()) carry.append('set-cookie', c);
  return { next: true, rewrite: h.get('x-middleware-rewrite') ?? undefined, headers, carry };
}

export function nextApp(options: NextAppOptions = {}): CreateApp {
  const { dir: given, ...rest } = options;
  const dir = resolve(given ?? '.');
  const appDir = [join(dir, 'app'), join(dir, 'src', 'app')].find((d) => existsSync(d));
  if (!appDir) throw new Error(`nextApp: no app/ or src/app/ folder in ${dir}. Oodle runs App Router route handlers.`);
  const routes = findRoutes(appDir);
  const middlewareFile = firstExisting(dir, ['middleware', 'proxy']) ?? firstExisting(join(dir, 'src'), ['middleware', 'proxy']);

  let runtime: Promise<{
    next: NextRuntime;
    middleware?: { run: (req: unknown, event: unknown) => Promise<globalThis.Response | undefined>; applies: (url: URL, req: globalThis.Request) => boolean };
  }> | undefined;
  const modules = new Map<string, Promise<InstanceType<NextRuntime['AppRouteRouteModule']>>>();

  const start = () => (runtime ??= (async () => {
    const next = nextRuntime(dir);
    next.loadEnv(dir);
    if (!middlewareFile) return { next };
    const mod = await load(middlewareFile);
    const fn = mod.middleware ?? mod.proxy ?? mod.default;
    if (typeof fn !== 'function') throw new Error(`nextApp: ${relative(dir, middlewareFile)} doesn't export a middleware function.`);
    const matcher = mod.config?.matcher;
    const applies = matcher && next.matchers ? next.matchers(matcher) : () => true;
    return {
      next,
      middleware: {
        run: async (req: unknown, event: unknown) => (await fn(req, event)) ?? undefined,
        applies: (url: URL, req: globalThis.Request) => {
          try {
            return applies(url.pathname, { headers: Object.fromEntries(req.headers) }, Object.fromEntries(url.searchParams));
          } catch {
            return true;
          }
        },
      },
    };
  })());

  const routeModule = (next: NextRuntime, route: RouteFile) => {
    if (!modules.has(route.file)) {
      modules.set(route.file, load(route.file).then((userland) => new next.AppRouteRouteModule({
        // Next 16 takes a loader for the route's module, Next 15 the module itself.
        userland: Number(next.version.split('.')[0]) >= 16 ? () => userland : userland,
        definition: { kind: 'APP_ROUTE', page: route.page, pathname: route.page.replace(/\/route$/, '') || '/', filename: 'route', bundlePath: `app${route.page}` },
        distDir: '.next',
        relativeProjectDir: '.',
        resolvedPagePath: route.file,
        nextConfigOutput: undefined,
      })));
    }
    return modules.get(route.file)!;
  };

  // The run in progress, so an error can be recorded as behavior. Runs are sequential.
  let current: AppContext | undefined;
  const fail = (where: string, err: unknown) => {
    current?.effects.emit('internal.next.error', { where, message: (err as Error)?.message ?? String(err) });
    return new globalThis.Response(null, { status: 500 });
  };

  const preview = { previewModeId: 'oodle', previewModeEncryptionKey: 'oodle', previewModeSigningKey: 'oodle' };

  // An uncaught error is a 500 to the caller, as in Next. The message is kept as internal behavior, which never affects an outcome.
  async function fetch(incoming: globalThis.Request): Promise<globalThis.Response> {
    const { next, middleware } = await start();
    try {
      return await serve(next, middleware, incoming);
    } catch (err) {
      return fail(new URL(incoming.url).pathname, err);
    }
  }

  async function serve(next: NextRuntime, middleware: Awaited<NonNullable<typeof runtime>>['middleware'], incoming: globalThis.Request): Promise<globalThis.Response> {
    let url = new URL(incoming.url);
    // Read the body once: the middleware and the route each get a request of their own.
    const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : await incoming.arrayBuffer();
    let headers = incoming.headers;
    let carry: Headers | undefined;

    if (middleware && middleware.applies(url, incoming)) {
      const waits: Promise<unknown>[] = [];
      const event = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, sourcePage: '/middleware' };
      const res = await middleware.run(new next.NextRequest(url, { method: incoming.method, headers, body }), event);
      await Promise.allSettled(waits);
      if (res) {
        const outcome = middlewareOutcome(res);
        if (!outcome.next) return outcome.response;
        carry = outcome.carry;
        if (outcome.rewrite) {
          const target = new URL(outcome.rewrite, url);
          if (target.origin !== url.origin) throw new Error(`nextApp: middleware rewrote ${url.pathname} to ${target.href}, another origin. Oodle doesn't proxy.`);
          url = target;
        }
        if (outcome.headers) headers = outcome.headers;
      }
    }

    let found: { route: RouteFile; params: Record<string, string | string[]> } | undefined;
    for (const route of routes) {
      const params = match(route, url.pathname);
      if (params) { found = { route, params }; break; }
    }
    if (!found) return withHeaders(new globalThis.Response(null, { status: 404 }), carry);

    const mod = await routeModule(next, found.route);
    const req = new next.NextRequest(url, { method: incoming.method, headers, body });
    const res = await mod.handle(req, {
      // A plain object: Next makes the params promise the handler awaits.
      params: found.params,
      // Next 15 reads the preview keys from prerenderManifest, Next 16 from previewProps.
      prerenderManifest: { preview },
      previewProps: preview,
      renderOpts: {
        experimental: {},
        supportsDynamicResponse: true,
        isRevalidate: false,
        onClose: () => {},
        onAfterTaskError: undefined,
        waitUntil: undefined,
      },
      sharedContext: { buildId: 'oodle', deploymentId: undefined },
    });
    return withHeaders(res, carry);
  }

  // Next loads when the app does, not on the first request: its node environment wraps Date, and must wrap the real one.
  const loaded = start().then(() => ({ fetch }));
  loaded.catch(() => {});
  return httpApp(loaded, {
    ...rest,
    routes: oodleRoutes(routes),
    setup: async (ctx) => {
      current = ctx;
      await rest.setup?.(ctx);
    },
  });
}

/** Headers and cookies the middleware set on NextResponse.next() reach the caller, as in Next. */
function withHeaders(res: globalThis.Response, carry: Headers | undefined): globalThis.Response {
  if (!carry || ![...carry.keys()].length) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of carry) if (k !== 'set-cookie' && !headers.has(k)) headers.set(k, v);
  for (const c of carry.getSetCookie()) headers.append('set-cookie', c);
  return new globalThis.Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
