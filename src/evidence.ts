/**
 * Evidence from outside the code, for discovery: what people wrote about the
 * API (OpenAPI), and what callers actually do with it (a HAR capture, an
 * OpenTelemetry trace export). Each reader turns its file into the same shape:
 * the requests it names, with the words and counts it carries, and for traffic,
 * the order requests came in. Nothing here runs or replays anything.
 * See docs/decisions/0010.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { OodleError } from './errors.ts';

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
}

type Request = { method: string; path: string; host?: string };

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
  return { kind: 'openapi', name, seen: host ? seen.map((s) => ({ ...s, host })) : seen, sequences: [] };
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
    const r = { method, path: url.pathname, host: url.host };
    all.push(r);
    const page = String(e.pageref ?? '');
    pages.set(page, [...(pages.get(page) ?? []), r]);
  }
  return { kind: 'har', name, seen: tally(all), sequences: [...pages.values()] };
}

/** OTLP JSON: the attribute value of a span, whichever of the old or new HTTP semantic conventions it uses. */
function attribute(span: any, ...keys: string[]): string | undefined {
  for (const a of span.attributes ?? []) if (keys.includes(a.key)) return a.value?.stringValue ?? (a.value?.intValue !== undefined ? String(a.value.intValue) : undefined);
  return undefined;
}

function otlp(doc: any, name: string): Evidence {
  const requests: Request[] = [];
  for (const rs of doc.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const span of ss.spans ?? []) {
        // Server spans only: a client span is this service calling someone else.
        if (span.kind !== undefined && span.kind !== 2 && span.kind !== 'SPAN_KIND_SERVER') continue;
        const method = (attribute(span, 'http.request.method', 'http.method') ?? '').toUpperCase();
        const path = attribute(span, 'http.route') ?? attribute(span, 'url.path', 'http.target')?.split('?')[0];
        if (METHODS.has(method) && path) requests.push({ method, path: template(path) });
      }
    }
  }
  return { kind: 'otlp', name, seen: tally(requests), sequences: [] };
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
