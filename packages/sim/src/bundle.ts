/**
 * A build, ready to run: its Worker bundled for workerd, its driver bundled for Node, its
 * migrations and its Wrangler config. Hono and @oodle/runtime always resolve to the copies Oodle
 * itself depends on, so every build runs on the same versions and needs no install to simulate.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Driver } from '@oodle/runtime';
import { type BuildOptions, build, type Plugin } from 'esbuild';

export interface Wrangler {
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  d1_databases?: { binding: string; database_id?: string; migrations_dir?: string }[];
  vars?: Record<string, string>;
}

export interface LoadedBuild {
  dir: string;
  wrangler: Wrangler;
  /** The Worker as one ES module. */
  script: string;
  driver: Driver;
  /** Migration files in order, as [name, sql]. */
  migrations: [string, string][];
}

/** JSON with comments and trailing commas, as Wrangler reads wrangler.jsonc. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function readWrangler(dir: string): Wrangler {
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const path = join(dir, name);
    if (existsSync(path)) return parseJsonc(readFileSync(path, 'utf8')) as Wrangler;
  }
  throw new Error(`${dir} has no wrangler.jsonc`);
}

const here = dirname(fileURLToPath(import.meta.url));

/** Hono and @oodle/runtime come from Oodle's own install, whatever the build's folder has. */
const shared: Plugin = {
  name: 'oodle-shared',
  setup(b) {
    b.onResolve({ filter: /^(hono|@oodle\/runtime)(\/.*)?$/ }, async (args) => {
      if (args.pluginData === 'shared') return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: 'shared' });
      return r.errors.length ? undefined : { path: r.path };
    });
  },
};

const BUNDLE: BuildOptions & { write: false } = {
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  logLevel: 'silent',
  plugins: [shared],
};

export async function loadBuild(dir: string): Promise<LoadedBuild> {
  dir = resolve(dir);
  const wrangler = readWrangler(dir);
  const main = join(dir, wrangler.main ?? 'src/index.tsx');

  const worker = await build({
    ...BUNDLE,
    entryPoints: [main],
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
  });
  const script = worker.outputFiles?.[0]?.text ?? '';

  const driverPath = ['src/oodle.driver.ts', 'src/oodle.driver.tsx'].map((p) => join(dir, p)).find(existsSync);
  if (!driverPath) throw new Error(`${dir} has no src/oodle.driver.ts`);
  const driverOut = await build({ ...BUNDLE, entryPoints: [driverPath], platform: 'node' });
  const code = driverOut.outputFiles?.[0]?.text ?? '';
  const cache = join(tmpdir(), 'oodle-drivers');
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${createHash('sha256').update(code).digest('hex').slice(0, 16)}.mjs`);
  if (!existsSync(file)) writeFileSync(file, code);
  const mod = (await import(pathToFileURL(file).href)) as { driver?: Driver; default?: Driver };
  const driver = mod.driver ?? mod.default;
  if (!driver?.actions) throw new Error(`${driverPath} must export \`driver\``);

  const mdir = join(dir, wrangler.d1_databases?.[0]?.migrations_dir ?? 'migrations');
  const migrations: [string, string][] = existsSync(mdir)
    ? readdirSync(mdir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => [f, readFileSync(join(mdir, f), 'utf8')])
    : [];

  return { dir, wrangler, script, driver, migrations };
}

/** Splits SQL into statements: on `;` outside quotes and comments. */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      for (i++; i < sql.length; i++) {
        if (sql[i] === ch && sql[i + 1] === ch) i++;
        else if (sql[i] === ch) break;
      }
      cur += sql.slice(start, i + 1);
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
