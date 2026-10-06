/**
 * The sealed simulation. While the runner runs an app, every way out to the
 * real network is closed: TCP and TLS sockets (which every HTTP client, database
 * driver and SDK ends up on) and fetch. The app talks to the world only through
 * `ctx.effects`, where every call is stubbed and recorded. An attempt to reach
 * past that is refused, so nothing real happens, and recorded as a violation of
 * the built-in `oodle.sealed` constraint, so it blocks. See docs/decisions/0005.
 *
 * Unix domain sockets stay open (they are local IPC, not network), and so do
 * child processes: a child is outside the seal. Hosts listed in
 * `sealed.allow` in oodlc/config.yaml pass through.
 *
 * A connection can also be routed: the simulated database (src/database.ts)
 * takes TCP connects to its address and hands them a Unix socket in this
 * process instead, so the app's driver reaches it without a port opening.
 */
import net from 'node:net';

export const SEALED_ID = 'oodle.sealed';

interface Active {
  allow: string[];
  /** Where the next escape is recorded: the run in progress, or the app load. */
  sink: string[];
  depth: number;
}

let active: Active | null = null;
const originalConnect = net.Socket.prototype.connect;
const originalFetch = globalThis.fetch;

/** Where a TCP connect goes instead, by host and port: a Unix socket path, or undefined to leave it alone. */
export type Route = (host: string, port: string | number | undefined, socket: net.Socket) => string | undefined;
let route: Route | null = null;

function allowed(host: string, port: string | number | undefined): boolean {
  return !!active && active.allow.some((a) => a === host || a === `${host}:${port}`);
}

function refuse(target: string): Error {
  active!.sink.push(target);
  const fix = target.endsWith(':5432')
    ? 'For Postgres, add database to oodlc/config.yaml and Oodle runs one in process.'
    : 'Route external calls through ctx.effects.call, or list the host under sealed.allow in oodlc/config.yaml.';
  return new Error(`Oodle sealed simulation: real network access to ${target} is blocked. ${fix}`);
}

/** Socket#connect accepts (options), (port, host), (path) or the internal normalized [options, cb] array. */
function targetOf(args: unknown[]): { path?: string; host: string; port?: string | number } {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const o = first as { path?: string; host?: string; port?: string | number };
    return { path: o.path, host: o.host ?? 'localhost', port: o.port };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first, host: '' };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first as number };
}

function sealedConnect(this: net.Socket, ...args: unknown[]) {
  const t = targetOf(args);
  const path = !t.path && route ? route(t.host, t.port, this) : undefined;
  if (path) {
    const cb = (Array.isArray(args[0]) ? args[0] : args).find((a) => typeof a === 'function');
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, cb ? [{ path }, cb] : [{ path }]);
  }
  if (active && !t.path && !allowed(t.host, t.port)) throw refuse(`${t.host}:${t.port ?? '?'}`);
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
}

/** Socket#connect is patched while the seal is on or a route is set, and only then. */
function patchConnect() {
  net.Socket.prototype.connect = active || route ? (sealedConnect as typeof net.Socket.prototype.connect) : originalConnect;
}

/** Routes TCP connects through `fn` until the returned function is called. Works with the seal on or off. */
export function routeConnections(fn: Route): () => void {
  route = fn;
  patchConnect();
  return () => {
    if (route !== fn) return;
    route = null;
    patchConnect();
  };
}

async function sealedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (active) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (!allowed(url.hostname, port)) throw refuse(`${url.hostname}:${port}`);
  }
  return originalFetch(input, init);
}

/** Seals the process until the returned function is called. Nested seals share the outermost one. */
export function seal(allow: string[] = []): () => void {
  if (active) {
    active.depth++;
  } else {
    active = { allow, sink: [], depth: 1 };
    patchConnect();
    globalThis.fetch = sealedFetch as typeof fetch;
  }
  return () => {
    if (!active || --active.depth > 0) return;
    active = null;
    patchConnect();
    globalThis.fetch = originalFetch;
  };
}

/** Runs `fn`, returning what it returned and every escape it attempted. */
export async function recordEscapes<T>(fn: () => Promise<T>): Promise<{ value: T; escapes: string[] }> {
  if (!active) return { value: await fn(), escapes: [] };
  const previous = active.sink;
  const escapes: string[] = [];
  active.sink = escapes;
  try {
    return { value: await fn(), escapes };
  } finally {
    if (active) active.sink = previous;
  }
}

export const sealViolations = (escapes: string[]) =>
  [...new Set(escapes)].map((t) => `constraint ${SEALED_ID} violated: the app reached the real network (${t}) instead of going through ctx.effects${t.endsWith(':5432') ? '; for Postgres, add database to oodlc/config.yaml and Oodle runs one in process' : ''}`);
