/**
 * Finds the outbound HTTP calls a service makes, without running it, so
 * `oodle init` can name them under `effects` and stub each one in
 * oodlc/config.yaml. Two sources: URL literals in the source (what fetch, axios
 * and friends are called with), and SDKs in package.json whose host is fixed.
 * Best effort: a host built from an environment variable can't be seen here, and
 * the seal still refuses and reports any call nothing names.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** SDKs that always talk to the same host. The kind is the first half of the effect kind. */
const SDKS: Record<string, { host: string; name: string }> = {
  stripe: { host: 'api.stripe.com', name: 'stripe' },
  '@sendgrid/mail': { host: 'api.sendgrid.com', name: 'sendgrid' },
  '@sendgrid/client': { host: 'api.sendgrid.com', name: 'sendgrid' },
  twilio: { host: 'api.twilio.com', name: 'twilio' },
  openai: { host: 'api.openai.com', name: 'openai' },
  '@anthropic-ai/sdk': { host: 'api.anthropic.com', name: 'anthropic' },
  resend: { host: 'api.resend.com', name: 'resend' },
  postmark: { host: 'api.postmarkapp.com', name: 'postmark' },
  '@slack/web-api': { host: 'slack.com/api', name: 'slack' },
  'mailgun.js': { host: 'api.mailgun.net', name: 'mailgun' },
  '@mailchimp/mailchimp_transactional': { host: 'mandrillapp.com', name: 'mandrill' },
  '@octokit/rest': { host: 'api.github.com', name: 'github' },
  octokit: { host: 'api.github.com', name: 'github' },
  '@linear/sdk': { host: 'api.linear.app', name: 'linear' },
  shippo: { host: 'api.goshippo.com', name: 'shippo' },
  '@paypal/paypal-server-sdk': { host: 'api-m.paypal.com', name: 'paypal' },
};

/** Hosts that show up in source without being called: specs, docs, schemas, loopback. */
const NOT_CALLED = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(www\.)?w3\.org|json-schema\.org|schema\.org|(www\.)?github\.com|(www\.)?npmjs\.(com|org)|nodejs\.org|developer\.mozilla\.org|(www\.)?example\.(com|org|net)|fonts\.(googleapis|gstatic)\.com|reactjs\.org|react\.dev|nextjs\.org|vercel\.com)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.git', '.turbo', '.vercel', 'oodlc', 'test', 'tests', '__tests__', '__mocks__', 'e2e', 'fixtures']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const MAX_FILES = 2000;

export interface OutboundCall {
  /** What an effect rule matches: a host, or a host and path prefix. */
  host: string;
  /** The effect kind init names it, e.g. stripe.request. */
  kind: string;
  /** Where it was found: a source file, or "package.json (stripe)". */
  found: string[];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      if (out.length >= MAX_FILES) return;
      if (n.startsWith('.') && n !== '.') continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(p);
      } else if (SOURCE.test(n) && !TEST_FILE.test(n) && n !== 'oodle.app.ts' && st.size < 512_000) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** Drops comments, so links in docs don't count as calls. `://` is kept: a URL's slashes follow a colon. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** The service a host belongs to: api.stripe.com → stripe, hooks.slack.com → slack. */
function serviceName(host: string): string {
  const parts = host.split('/')[0].split(':')[0].split('.');
  const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'external';
}

/** Outbound hosts the service in `dir` calls, with an effect kind for each. */
export function scanOutbound(dir: string): OutboundCall[] {
  const found = new Map<string, Set<string>>();
  const add = (host: string, where: string) => found.set(host, (found.get(host) ?? new Set()).add(where));

  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    deps = { ...pkg.dependencies };
  } catch { /* no package.json */ }
  const sdkName = new Map<string, string>();
  for (const [pkg, sdk] of Object.entries(SDKS)) {
    if (!(pkg in deps)) continue;
    add(sdk.host, `package.json (${pkg})`);
    sdkName.set(sdk.host, sdk.name);
  }

  for (const file of sourceFiles(dir)) {
    let src: string;
    try { src = code(readFileSync(file, 'utf8')); } catch { continue; }
    for (const m of src.matchAll(/['"`]https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/gi)) {
      const host = m[1].toLowerCase();
      if (NOT_CALLED.test(host)) continue;
      add(host, relative(dir, file).split(sep).join('/'));
    }
  }

  const hosts = [...found.keys()];
  const names = new Map<string, string>();
  for (const h of hosts) names.set(h, sdkName.get(h) ?? serviceName(h));
  // Two hosts of the same service (api.stripe.com and files.stripe.com) keep distinct kinds.
  const kindOf = (h: string) => {
    const name = names.get(h)!;
    const twins = hosts.filter((o) => names.get(o) === name);
    if (twins.length === 1) return `${name}.request`;
    return `${name}.${h.split('/')[0].split('.')[0].replace(/[^a-z0-9-]/g, '')}`;
  };
  return hosts.sort().map((host) => ({ host, kind: kindOf(host), found: [...found.get(host)!].sort() }));
}

/**
 * Effect kinds an app module names: the values of an `effects` map or list
 * passed to httpApp/nextApp, and every ctx.effects.call('kind') in a contract
 * app. Read from the text, so nothing runs.
 */
export function declaredEffects(appFile: string): string[] {
  if (!existsSync(appFile)) return [];
  const src = code(readFileSync(appFile, 'utf8'));
  const kinds = new Set<string>();
  const block = /\beffects\s*:\s*([[{])/g;
  for (let m; (m = block.exec(src));) {
    // The matching bracket, so nested objects and regexps inside the block don't end it early.
    const open = m[1];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === open) depth++;
      else if (src[end] === close && --depth === 0) break;
    }
    const body = src.slice(m.index + m[0].length, end);
    if (open === '{') for (const p of body.matchAll(/(['"`])[^'"`]+\1\s*:\s*(['"`])([\w.-]+)\2/g)) kinds.add(p[3]);
    else for (const p of body.matchAll(/\bkind\s*:\s*(['"`])([\w.-]+)\1/g)) kinds.add(p[2]);
  }
  for (const m of src.matchAll(/\beffects\.call\(\s*(['"`])([\w.-]+)\1/g)) kinds.add(m[2]);
  return [...kinds];
}

// ── Databases ───────────────────────────────────────────────────────────────

/** Postgres clients that speak the wire protocol over TCP, which the simulated database serves. */
const PG_DRIVERS = ['pg', 'postgres', 'pg-promise', 'slonik', '@prisma/adapter-pg'];
/** Postgres clients that talk HTTP or WebSockets to a hosted proxy instead, which it can't. */
const HTTP_DRIVERS = ['@neondatabase/serverless', '@vercel/postgres'];

/** Where migrations tools keep their SQL, most specific first. */
const SCHEMA_PLACES = [
  'prisma/migrations', 'drizzle', 'supabase/migrations', 'migrations', 'db/migrations', 'database/migrations',
  'sql/migrations', 'src/db/migrations', 'src/migrations', 'db/schema.sql', 'schema.sql', 'sql/schema.sql', 'database/schema.sql', 'db/structure.sql',
];

export interface DatabaseFound {
  /** The Postgres client in package.json, e.g. pg. */
  driver: string;
  /** The migrations folder or .sql file that creates the tables, relative to the project, if one was found. */
  schema?: string;
  /** Environment variables the code reads a connection string from. */
  env: string[];
  /** A client Oodle can't serve in process, because it talks HTTP to a hosted proxy. */
  unsupported?: boolean;
}

function hasSql(path: string, depth = 0): boolean {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return path.endsWith('.sql');
    if (depth > 2) return false;
    return readdirSync(path).some((n) => !n.startsWith('.') && hasSql(join(path, n), depth + 1));
  } catch {
    return false;
  }
}

/** The Postgres the service in `dir` uses: its client, its schema, and how it finds the database. Read, never run. */
export function scanDatabase(dir: string): DatabaseFound | null {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch { /* no package.json */ }
  const driver = PG_DRIVERS.find((d) => d in deps);
  const http = HTTP_DRIVERS.find((d) => d in deps);
  if (!driver && !http) return null;

  // drizzle-kit writes its SQL where drizzle.config says.
  const drizzleOut = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']
    .map((f) => { try { return /\bout\s*:\s*['"`]\.?\/?([^'"`]+?)\/?['"`]/.exec(readFileSync(join(dir, f), 'utf8'))?.[1]; } catch { return undefined; } })
    .find(Boolean);
  const schema = [...(drizzleOut ? [drizzleOut] : []), ...SCHEMA_PLACES].find((p) => hasSql(join(dir, p)));

  const env = new Set<string>();
  const URL_VAR = /\b((?:[A-Z0-9]+_)*(?:DATABASE|POSTGRES|PG|DB)(?:_[A-Z0-9]+)*_URL(?:_[A-Z0-9]+)*|DATABASE_URL)\b/;
  const files = [...sourceFiles(dir), join(dir, 'prisma', 'schema.prisma')];
  for (const file of files) {
    let src: string;
    try { src = code(readFileSync(file, 'utf8')); } catch { continue; }
    for (const m of src.matchAll(/(?:process\.env\.|process\.env\[['"`]|env\(\s*['"`])([A-Z][A-Z0-9_]*)/g)) if (URL_VAR.test(m[1])) env.add(m[1]);
  }
  return {
    driver: driver ?? http!,
    ...(schema ? { schema } : {}),
    env: env.size ? [...env].sort() : ['DATABASE_URL'],
    ...(driver ? {} : { unsupported: true }),
  };
}
