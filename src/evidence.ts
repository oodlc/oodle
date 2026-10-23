/**
 * Evidence from outside the code, for discovery: what people wrote about the
 * API (OpenAPI), and what callers actually do with it (a HAR capture, an
 * OpenTelemetry trace export). Each reader turns its file into the same shape:
 * the requests it names, with the words and counts it carries, and for traffic,
 * the order requests came in. Nothing here runs or replays anything.
 * See docs/decisions/0010.
 *
 * Traffic is scrubbed here, as it is read (0015): paths lose their ids and query
 * strings, headers are never kept, and bodies keep their shape and codes but none
 * of anyone's data (src/scrub.ts). No raw value leaves this module.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { OodleError } from './errors.ts';
import { Scrubber, scrubBody } from './scrub.ts';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface Seen {
  method: string;
  /** For traffic: the host it went to. A capture holds other sites' requests too. */
  host?: string;
  /** A template (`/orders/:id`, from a spec) or a concrete path (`/orders/ord_9`, from traffic). */
  path: string;
  /** How many requests, for traffic. */
  count?: number;
  /** The words people wrote, for a spec. */
  summary?: string;
  operationId?: string;
  tags?: string[];
}

export interface Evidence {
  kind: 'openapi' | 'har' | 'otlp';
  /** The file's name, as evidence lines cite it. */
  name: string;
  seen: Seen[];
  /** For traffic: requests in the order one caller made them (a HAR page, or the whole capture). */
  sequences: Request[][];
  scope: Scope;
  /** For traffic: every request with what came of it, scrubbed. What stubs and probe bodies are drafted from (0015). */
  calls: Call[];
}

/** One request in a capture or trace export, with nothing personal or secret left in it. */
export interface Call {
  method: string;
  host?: string;
  /** Scrubbed: `/orders/:id`, never `/orders/ord_9`. */
  path: string;
  status?: number;
  /** How long it took, in milliseconds. */
  ms?: number;
  /** The request and response bodies, parsed and scrubbed. A HAR may hold them; traces don't. */
  request?: unknown;
  response?: unknown;
  /** A client span: this service calling another. In a HAR, which way a request went depends on where it was recorded. */
  outbound?: boolean;
}

/**
 * What one file covered. A route it never reached was not seen in that window, on those hosts:
 * that is all its silence says. See docs/decisions/0014.
 */
export interface Scope {
  kind: Evidence['kind'];
  file: string;
  /** For traffic: when the first and the last request started (ISO 8601), when the file says. */
  first?: string;
  last?: string;
  /** Requests in a capture or trace export, operations in a spec. */
  requests: number;
  /** Every host its requests went to (a spec: the hosts it names), busiest first. */
  hosts: string[];
}

type Request = { method: string; path: string; host?: string };

/** File types a browser fetches that are no API: a capture is full of them. */
export const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|html?|txt|json)$/i;
/** A path segment that names a kind of thing, never a record or a secret: `orders`, `password-reset`, `v2`. */
const WORD = /^([a-z][a-z_-]{0,39}|v\d+)$/;

/**
 * A captured path with nothing personal or secret left in it (0015). The query string goes, and every
 * segment that isn't a plain lowercase word becomes a parameter: ids, emails, tokens, names, anything
 * encoded. An asset keeps only its extension, so discovery can still leave it out. Captured paths are
 * scrubbed as they are read, so the raw ones never reach the catalog, the terminal or the JSON.
 */
export function scrubPath(path: string): string {
  return path.split('?')[0].split('/').map((seg, i) => {
    if (i === 0 || !seg || /^:[a-zA-Z_]\w*$/.test(seg) || WORD.test(seg)) return seg;
    const ext = ASSET.exec(seg)?.[0];
    return ext ? `:file${ext.toLowerCase()}` : ':id';
  }).join('/');
}

/** Hosts by how many requests went to each, busiest first. */
const hostsOf = (hosts: (string | undefined)[]) => {
  const n = new Map<string, number>();
  for (const h of hosts) if (h) n.set(h, (n.get(h) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h]) => h);
};

/** The earliest and latest of some timestamps, as ISO 8601. */
function timeWindow(times: number[]): { first?: string; last?: string } {
  const ok = times.filter((t) => Number.isFinite(t));
  if (!ok.length) return {};
  return { first: new Date(Math.min(...ok)).toISOString(), last: new Date(Math.max(...ok)).toISOString() };
}

/** `/orders/{id}/refund` -> `/orders/:id/refund`, the form routes and surfaces use. */
const template = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');

function openapi(doc: any, name: string): Evidence {
  const seen: Seen[] = [];
  const prefix = (() => {
    // Swagger 2 has basePath; OpenAPI 3 may put a path on its first server.
    if (typeof doc.basePath === 'string') return doc.basePath.replace(/\/$/, '');
    const url = doc.servers?.[0]?.url;
    if (typeof url !== 'string') return '';
    try {
      return new URL(url, 'http://x').pathname.replace(/\/$/, '');
    } catch {
      return '';
    }
  })();
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item ?? {})) {
      if (!METHODS.has(method.toUpperCase()) || !op || typeof op !== 'object') continue;
      seen.push({
        method: method.toUpperCase(),
        path: template(`${prefix}${path}`),
        ...(op.summary || op.description ? { summary: String(op.summary ?? op.description).trim().split('\n')[0] } : {}),
        ...(op.operationId ? { operationId: String(op.operationId) } : {}),
        ...(Array.isArray(op.tags) && op.tags.length ? { tags: op.tags.map(String) } : {}),
      });
    }
  }
  // The host the spec says it serves, so traffic to it can be told from other sites'.
  let host: string | undefined;
  try {
    host = doc.host ?? (doc.servers?.[0]?.url ? new URL(doc.servers[0].url).host || undefined : undefined);
  } catch {
    host = undefined;
  }
  return { kind: 'openapi', name, seen: host ? seen.map((s) => ({ ...s, host })) : seen, sequences: [], scope: { kind: 'openapi', file: name, requests: seen.length, hosts: host ? [host] : [] }, calls: [] };
}

/** Counts requests by host, method and path, keeping the first-seen order. */
function tally(requests: Request[]): Seen[] {
  const counts = new Map<string, Seen>();
  for (const r of requests) {
    const key = `${r.host ?? ''} ${r.method} ${r.path}`;
    const s = counts.get(key) ?? { method: r.method, path: r.path, ...(r.host ? { host: r.host } : {}), count: 0 };
    s.count!++;
    counts.set(key, s);
  }
  return [...counts.values()];
}

function har(doc: any, name: string): Evidence {
  const pages = new Map<string, Request[]>();
  const all: Request[] = [];
  const times: number[] = [];
  const calls: Call[] = [];
  const scrubber = new Scrubber();
  const entries = [...(doc.log?.entries ?? [])].sort((a: any, b: any) => String(a.startedDateTime ?? '').localeCompare(String(b.startedDateTime ?? '')));
  for (const e of entries) {
    const method = String(e.request?.method ?? '').toUpperCase();
    if (!METHODS.has(method)) continue;
    let url: URL;
    try {
      url = new URL(String(e.request.url));
    } catch {
      continue;
    }
    const r = { method, path: scrubPath(url.pathname), host: url.host };
    all.push(r);
    const status = Number(e.response?.status);
    const request = scrubBody(scrubber, e.request?.postData?.text, e.request?.postData?.mimeType, undefined, e.request?.postData?.params);
    const response = scrubBody(scrubber, e.response?.content?.text, e.response?.content?.mimeType, e.response?.content?.encoding);
    calls.push({ ...r, ...(status > 0 ? { status } : {}), ...(Number(e.time) >= 0 ? { ms: Math.round(Number(e.time)) } : {}), ...(request !== undefined ? { request } : {}), ...(response !== undefined ? { response } : {}) });
    times.push(Date.parse(String(e.startedDateTime ?? '')));
    const page = String(e.pageref ?? '');
    pages.set(page, [...(pages.get(page) ?? []), r]);
  }
  const scope: Scope = { kind: 'har', file: name, ...timeWindow(times), requests: all.length, hosts: hostsOf(all.map((r) => r.host)) };
  return { kind: 'har', name, seen: tally(all), sequences: [...pages.values()], scope, calls };
}

/** OTLP JSON: the attribute value of a span, whichever of the old or new HTTP semantic conventions it uses. */
function attribute(span: any, ...keys: string[]): string | undefined {
  for (const a of span.attributes ?? []) if (keys.includes(a.key)) return a.value?.stringValue ?? (a.value?.intValue !== undefined ? String(a.value.intValue) : undefined);
  return undefined;
}

/** OTLP JSON timestamps are nanoseconds since the epoch, as a string or a number. */
const fromNanos = (v: unknown) => (v === undefined || v === null || v === '' ? NaN : Number(BigInt(String(v)) / 1_000_000n));

function otlp(doc: any, name: string): Evidence {
  const requests: Request[] = [];
  const times: number[] = [];
  const hosts: (string | undefined)[] = [];
  const calls: Call[] = [];
  for (const rs of doc.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const span of ss.spans ?? []) {
        const method = (attribute(span, 'http.request.method', 'http.method') ?? '').toUpperCase();
        const status = Number(attribute(span, 'http.response.status_code', 'http.status_code'));
        let ms: number | undefined;
        try {
          ms = (fromNanos(span.endTimeUnixNano) - fromNanos(span.startTimeUnixNano)) || undefined;
        } catch {
          ms = undefined;
        }
        const timing = { ...(status > 0 ? { status } : {}), ...(ms !== undefined && ms >= 0 ? { ms } : {}) };
        // A client span is this service calling someone else: what a stub stands in for (0015). Traces carry no bodies.
        if (span.kind === 3 || span.kind === 'SPAN_KIND_CLIENT') {
          let url: URL | undefined;
          try {
            url = new URL(String(attribute(span, 'url.full', 'http.url')));
          } catch {
            url = undefined;
          }
          if (METHODS.has(method) && url) calls.push({ method, host: url.host, path: scrubPath(url.pathname), ...timing, outbound: true });
          continue;
        }
        if (span.kind !== undefined && span.kind !== 2 && span.kind !== 'SPAN_KIND_SERVER') continue;
        const path = attribute(span, 'http.route') ?? attribute(span, 'url.path', 'http.target')?.split('?')[0];
        if (!METHODS.has(method) || !path) continue;
        requests.push({ method, path: scrubPath(template(path)) });
        calls.push({ method, path: scrubPath(template(path)), ...timing });
        hosts.push(attribute(span, 'server.address', 'net.host.name', 'http.host')?.replace(/:\d+$/, ''));
        try {
          times.push(fromNanos(span.startTimeUnixNano));
        } catch {
          // A timestamp that isn't a number leaves the window open, nothing more.
        }
      }
    }
  }
  const scope: Scope = { kind: 'otlp', file: name, ...timeWindow(times), requests: requests.length, hosts: hostsOf(hosts) };
  return { kind: 'otlp', name, seen: tally(requests), sequences: [], scope, calls };
}

const NOUN: Record<Evidence['kind'], [one: string, short: string]> = { har: ['HAR capture', 'HAR'], otlp: ['OTLP trace export', 'OTLP traces'], openapi: ['OpenAPI spec', 'OpenAPI'] };

/** "40 min", "2 h 5 min", "3 days": how long a capture ran, from its first request to its last. */
export function duration(scope: Scope): string | undefined {
  if (!scope.first || !scope.last) return undefined;
  const min = (Date.parse(scope.last) - Date.parse(scope.first)) / 60_000;
  if (min < 1) return 'under a minute';
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h${Math.round(min % 60) ? ` ${Math.round(min % 60)} min` : ''}`;
  return `${Math.round(min / 1440)} days`;
}

const list = (xs: string[], max = 5) => `${xs.slice(0, max).join(', ')}${xs.length > max ? `, and ${xs.length - max} more` : ''}`;

/** "40 min, 312 requests, hosts: a, b, c": what a file covered, in words. */
export function scopeFacts(scope: Scope): string {
  const n = scope.requests;
  const what = scope.kind === 'openapi' ? `${n} operation${n === 1 ? '' : 's'}` : `${n} request${n === 1 ? '' : 's'}`;
  return [duration(scope), what, ...(scope.hosts.length ? [`host${scope.hosts.length === 1 ? '' : 's'}: ${list(scope.hosts)}`] : [])].filter(Boolean).join(', ');
}

/**
 * Where something was not seen, and how much that covers: "Not seen in 1 HAR capture, session.har
 * (40 min, 312 requests, hosts: a, b, c). That doesn't mean it's unused." Absence in a capture is
 * never evidence that nobody uses a route.
 */
export function notSeenIn(scopes: Scope[]): string {
  const kinds = new Set(scopes.map((s) => s.kind));
  const where = scopes.length === 1
    ? `1 ${NOUN[scopes[0].kind][0]}, ${scopes[0].file} (${scopeFacts(scopes[0])})`
    : `${scopes.length} ${kinds.size === 1 ? `${NOUN[scopes[0].kind][0]}s` : 'captures'}: ${scopes.map((s) => `${s.file} (${kinds.size === 1 ? '' : `${NOUN[s.kind][1]}, `}${scopeFacts(s)})`).join(' and ')}`;
  return `Not seen in ${where}. That doesn't mean it's unused.`;
}

/** Reads one evidence file, telling the format by its shape. */
export function readEvidence(file: string): Evidence {
  let doc: any;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new OodleError('evidence', `Can't read ${file}: ${(err as Error).message}`, { hint: 'Pass an OpenAPI spec (JSON or YAML), a HAR capture, or an OTLP JSON trace export.' });
  }
  const name = basename(file);
  if (doc?.openapi || doc?.swagger) return openapi(doc, name);
  if (doc?.log?.entries) return har(doc, name);
  if (doc?.resourceSpans) return otlp(doc, name);
  throw new OodleError('evidence', `${file} is not an OpenAPI spec, a HAR capture or an OTLP trace export`, {
    hint: 'OpenAPI has an "openapi" or "swagger" key, a HAR file a "log.entries" list, and an OTLP JSON export "resourceSpans".',
  });
}

/** A path segment that names one record rather than a kind of thing: `ord_1`, `42`, a uuid. `v2` is a version. */
const RECORD = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[a-z]+[_-]?[a-z0-9]*\d[a-z0-9_-]*)$/i;

/** `/orders/ord_1/refund` -> `/orders/:id/refund`. An inference: a person can rename the routes it gives. */
export function templateOf(path: string): string {
  return path.split('/').map((seg, i) => (i > 0 && !seg.startsWith(':') && !/^v\d+$/.test(seg) && RECORD.test(seg) ? ':id' : seg)).join('/');
}

/**
 * The routes evidence implies, for a project with no app to ask (0011): a spec's
 * operations as they are, then traffic templated where no spec route covers it.
 * Traffic counts only on the service's own host: the spec's, or else the one
 * most of the non-asset requests went to.
 */
export function routesFrom(evidence: Evidence[], reaches: (surface: string, route: string) => boolean, asset: RegExp): string[] {
  const routes: string[] = [];
  const add = (r: string) => {
    if (!routes.includes(r)) routes.push(r);
  };
  for (const e of evidence) if (e.kind === 'openapi') for (const s of e.seen) add(`${s.method} ${s.path}`);
  const declared = new Set(evidence.flatMap((e) => (e.kind === 'openapi' ? e.seen.map((s) => s.host).filter(Boolean) : [])));
  const traffic = evidence.filter((e) => e.kind !== 'openapi').flatMap((e) => e.seen).filter((s) => !asset.test(s.path));
  const byHost = new Map<string, number>();
  for (const s of traffic) if (s.host) byHost.set(s.host, (byHost.get(s.host) ?? 0) + (s.count ?? 1));
  const busiest = [...byHost].sort((a, b) => b[1] - a[1])[0]?.[0];
  const own = declared.size ? declared : new Set(busiest ? [busiest] : []);
  for (const s of traffic) {
    if (s.host && own.size && !own.has(s.host)) continue;
    if (routes.some((r) => reaches(`${s.method} ${s.path}`, r))) continue;
    add(`${s.method} ${templateOf(s.path)}`);
  }
  return routes;
}
