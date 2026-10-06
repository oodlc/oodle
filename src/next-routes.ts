/**
 * Where a Next.js App Router app keeps its route handlers and middleware, read from the file tree.
 * No side effects, so `oodle mutate` can use it without loading Next. See src/next.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];

export interface RouteFile {
  file: string;
  /** Next's page name, e.g. /api/orders/[id]/route. */
  page: string;
  /** Path segments: static text, or a parameter. */
  segments: ({ text: string } | { param: string; kind: 'one' | 'all' | 'optional' })[];
  methods: string[];
}

/** The methods a route file exports, read from its source so listing routes loads nothing. */
function exportedMethods(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)([A-Z]+)\b/g)) found.add(m[1]);
  for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) found.add(part.trim().split(/\s+as\s+/).pop()!.trim());
  }
  return METHODS.filter((m) => found.has(m));
}

export function findRoutes(appDir: string): RouteFile[] {
  const out: RouteFile[] = [];
  const walk = (dir: string, segments: RouteFile['segments']) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        // Private folders, parallel slots and intercepting routes aren't URL paths of their own.
        if (name.startsWith('_') || name.startsWith('@') || /^\(\.+\)/.test(name)) continue;
        if (/^\(.*\)$/.test(name)) { walk(path, segments); continue; }
        const param = /^\[(\[)?(\.\.\.)?([^\]]+)\]?\]$/.exec(name);
        walk(path, [...segments, param ? { param: param[3], kind: param[1] ? 'optional' : param[2] ? 'all' : 'one' } : { text: name }]);
      } else if (EXTS.some((e) => name === `route${e}`)) {
        const page = `/${relative(appDir, path).split(sep).slice(0, -1).join('/')}/route`.replace(/^\/\/route$/, '/route');
        out.push({ file: path, page, segments, methods: exportedMethods(readFileSync(path, 'utf8')) });
      }
    }
  };
  walk(appDir, []);
  // Static segments win over parameters, and parameters over catch-alls, as in Next.
  const rank = (r: RouteFile) => r.segments.map((s) => ('text' in s ? 0 : s.kind === 'one' ? 1 : s.kind === 'all' ? 2 : 3));
  return out.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return y.length - x.length;
  });
}

export function firstExisting(dir: string, names: string[]): string | undefined {
  for (const n of names) for (const e of EXTS) if (existsSync(join(dir, n + e))) return join(dir, n + e);
  return undefined;
}

/** The files a Next app runs: its route handlers and middleware. `oodle mutate` starts its import graph here. */
export function nextSourceFiles(dir: string): string[] {
  const appDir = [join(dir, 'app'), join(dir, 'src', 'app')].find((d) => existsSync(d));
  const middleware = firstExisting(dir, ['middleware', 'proxy']) ?? firstExisting(join(dir, 'src'), ['middleware', 'proxy']);
  return [...(appDir ? findRoutes(appDir).map((r) => r.file) : []), ...(middleware ? [middleware] : [])];
}
