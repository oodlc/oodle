import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { CONFIG_FILE, FOLDER, configFile, schemaLine } from './catalog.ts';
import { OodleError } from './errors.ts';
import { packageManager } from './invocation.ts';
import { display } from './project.ts';
import { type DatabaseFound, type OutboundCall, declaredEffects, scanDatabase, scanOutbound } from './scan.ts';
import { readWrangler } from './workers.ts';

/** The effects block of a generated adapter: the calls init found, or examples to fill in. */
function effectLines(calls: OutboundCall[], examples: string[]): string {
  if (!calls.length) return examples.map((e) => `    // ${e}\n`).join('');
  const width = Math.max(...calls.map((c) => `'${c.host}': '${c.kind}',`.length));
  return calls.map((c) => `    ${`'${c.host}': '${c.kind}',`.padEnd(width)} // ${c.found.slice(0, 3).join(', ')}${c.found.length > 3 ? ', …' : ''}\n`).join('');
}

/** The database block of a generated config: the schema init found, or a TODO pointing at one. */
const DATABASE = (db: DatabaseFound) => db.engine === 'sqlite' ? `# D1 is SQLite: Oodle runs it in process (node:sqlite, Node 22.13 or later), with the migrations applied.
# Every run starts from them plus given.db, and every row the Worker writes is recorded as an effect.
database:
  engine: sqlite
${db.schema ? `  schema: ${db.schema}` : '  # schema: migrations          # TODO: the folder wrangler d1 migrations apply'}
` : `# A real Postgres for your app, simulated in process (PGlite): no Docker, no port, nothing to clean up.
# Oodle applies the schema once; every run starts from it plus given.db. Your app connects through
# ${db.env.join(', ')} with its own driver (${db.driver}), and every row it writes is recorded as an effect.
database:
${db.schema ? `  schema: ${db.schema}` : '  # schema: db/schema.sql       # TODO: the .sql file or migrations folder that creates your tables'}
${db.env.length === 1 && db.env[0] === 'DATABASE_URL' ? '' : `  env: [${db.env.join(', ')}]\n`}`;

const CONFIG = (app: string, kinds: string[] = [], db?: DatabaseFound) => `${schemaLine('config')}# Oodle project config. Every other .yaml file in this folder is catalog.
# Docs: https://oodlc.com/docs/guide#writing-a-catalog
app: ${app}            # default export createApp(ctx), relative to the project root
${db ? DATABASE(db) : ''}defaults:
  given:
${db ? '    db: {}                     # rows each table starts with, e.g. users: [{ id: u1, email: ada@example.com }]\n' : '    state: {}\n'}${kinds.length
    ? `    # Every external call the app makes needs a stub. These are placeholders for the calls
    # in ${app}: put in what each API answers, e.g. { result: { id: ch_1, status: succeeded } }.
    stubs:
${kinds.map((k) => `      ${k}: { result: {} }\n`).join('')}`
    : '    stubs: {}               # every external call the app makes needs a stub, e.g. payment.capture\n'}`;

const INTENTS = `${schemaLine('catalog')}version: 0
# Intents say why the product exists. Every outcome traces to one.
intents:
  - id: service-available
    statement: Callers can rely on the service being there when they need it.
`;

/** A project that explains a system Oodle can't run: no app, so nothing runs and nothing blocks. See docs/decisions/0011. */
const INVENTORY_CONFIG = `${schemaLine('config')}# Oodle project config, for a project that explains a system rather than protecting it.
# There is no app: Oodle reads evidence (an OpenAPI spec, a HAR capture, an OTLP trace export)
# and asks people for the words. To protect a Node service too, add app: and its outcomes.
# Docs: https://oodlc.com/docs/guide#describing-the-system
`;

const INVENTORY_INTENTS = `${schemaLine('catalog')}version: 0
# Intents say why the product exists. Capabilities say what it lets people do, and trace to them.
# Draft capabilities from evidence with \`oodle discover --from <file>\`, then \`oodle interview\`.
intents: []
`;

const OUTCOMES = `${schemaLine('catalog')}version: 0
# Outcomes are what someone outside the system must experience. They block a merge when they break.
outcomes:
  - id: service.reachable
    intent: service-available
    statement: A caller asking for health gets a quick, positive answer
    boundary: external
    trigger:
      http: GET /health
    expect:
      status: 200
      body:
        ok: true
`;

/** Marks the starter app, so `oodle doctor` can tell when Oodle is still running it instead of your code. */
export const STARTER_MARK = 'oodle:starter';

const APP = `// ${STARTER_MARK}: replace this with your app. \`oodle doctor\` reports it until you do.
/**
 * The OODLC app contract: createApp(ctx) returns { routes, handle }.
 * Send every external call through ctx.effects.call and every side effect through
 * ctx.effects.emit, and take ids and time from ctx, so Oodle can simulate the
 * world around the app and record what it does.
 */
export default function createApp(ctx: any) {
  const routes = [{ method: 'GET', path: '/health' }];
  return {
    routes,
    async handle(req: { method: string; path: string; body?: unknown }) {
      if (req.method === 'GET' && req.path === '/health') return { status: 200, body: { ok: true } };
      return { status: 404, body: { error: 'not_found' } };
    },
  };
}
`;

const OUTCOMES_TODO = `${schemaLine('catalog')}version: 0
# Outcomes are what someone outside the system must experience. They block a merge when they break.
# Oodle protects nothing until there is one. Start with the promise that would hurt most to break, e.g.:
#
#   - id: orders.paid-with-receipt
#     intent: service-available
#     statement: A customer who pays gets a confirmation and exactly one receipt
#     boundary: customer
#     trigger:
#       http: POST /orders
#       given: { body: { items: [{ sku: tee, qty: 1 }] } }
#     expect:
#       status: 201
#       body: { id: { exists: true } }
#       effects:
#         - { kind: email.sent, count: 1 }
outcomes: []
`;

// ── Existing services ───────────────────────────────────────────────────────

const FRAMEWORKS = ['express', 'fastify', 'koa', 'hono', 'connect', 'polka', '@hapi/hapi', 'restify'] as const;
const ENTRY_NAMES = ['src/server', 'src/app', 'src/index', 'src/main', 'server', 'app', 'index', 'main'];
const ENTRY_EXTS = ['.ts', '.mts', '.js', '.mjs', '.cjs'];
const SERVER_CODE = /\bexpress\(|new Koa\b|new Hono\b|\bfastify\(|Fastify\(|createServer\(|\.listen\(/;

export interface Service {
  /** The module that builds the app, relative to the project. */
  entry: string;
  framework: (typeof FRAMEWORKS)[number] | 'node' | 'next' | 'worker';
  /** A Worker: the Wrangler config it was found from, and the paths its code compares a URL against. */
  wrangler?: string;
  routes?: string[];
  /** How the entry exports the app: a named export, 'default', or null if it doesn't seem to. */
  exportName: string | null;
  /** The entry calls listen() itself, so importing it would open a port. */
  listensOnImport: boolean;
  /** package.json says "type": "module", so the adapter can use import.meta. */
  esm?: boolean;
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

const BUILDS_APP = /\bexpress\(|new Koa\b|new Hono\b|\bfastify\(|Fastify\(|createServer\(|\bconnect\(\)|\bpolka\(/;
const listensIn = (src: string) => /\.listen\(/.test(src) && !/(import\.meta\.main|require\.main\s*===\s*module|process\.argv\[1\])/.test(src);

/** How `entry` exports the app, and whether importing it would listen. */
function describe(entry: string, src: string, framework: Service['framework'] | undefined): Service {
  const named = /export\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:express|Fastify|fastify|new\s+Koa|new\s+Hono|(?:http|https)\.createServer|createServer|connect|polka)\b/.exec(src)?.[1]
    ?? /export\s*\{\s*(app|server)\b/.exec(src)?.[1];
  const exportName = named ?? (/export\s+default\b|module\.exports\s*=/.test(src) ? 'default' : null);
  const kind = framework ?? (/\bexpress\(/.test(src) ? 'express' : /new Koa\b/.test(src) ? 'koa' : /new Hono\b/.test(src) ? 'hono' : /fastify\(/i.test(src) ? 'fastify' : 'node');
  return { entry: entry.split(sep).join('/'), framework: kind, exportName, listensOnImport: listensIn(src) };
}

/** The file a relative import names, trying the extensions TypeScript and Node would. */
function resolveImport(dir: string, from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec);
  // TypeScript sources import './app.js' and mean app.ts.
  const bare = base.replace(/\.[cm]?js$/, '');
  for (const candidate of [base, ...ENTRY_EXTS.map((e) => bare + e), ...ENTRY_EXTS.map((e) => join(base, `index${e}`))]) {
    try { if (statSync(join(dir, candidate)).isFile()) return candidate; } catch { /* try the next one */ }
  }
  return null;
}

/**
 * Follows `app.listen()`, `createServer(app)` or `serve({ fetch: app.fetch })` in an entry
 * back to the module that builds the app.
 */
function followListen(dir: string, entry: string, src: string, framework: Service['framework'] | undefined): Service | null {
  const started = new Set([
    ...[...src.matchAll(/\b([A-Za-z_$][\w$]*)\.listen\(/g)].map((m) => m[1]),
    ...[...src.matchAll(/createServer\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)].map((m) => m[1]),
    ...[...src.matchAll(/fetch\s*:\s*([A-Za-z_$][\w$]*)\.fetch\b/g)].map((m) => m[1]),
  ]);
  for (const found of started) {
    const name = found.replace(/\$/g, '\\$');
    const q = `['"]([^'"]+)['"]`;
    const imports: [RegExp, (m: RegExpExecArray) => string][] = [
      [new RegExp(`import\\s+${name}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*${q}`), () => 'default'],
      [new RegExp(`import\\s+(?:\\w+\\s*,\\s*)?\\{[^}]*?\\b(?:(\\w+)\\s+as\\s+)?${name}\\b[^}]*\\}\\s*from\\s*${q}`), (m) => m[1] ?? found],
      [new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*require\\(\\s*${q}\\s*\\)`), () => 'default'],
      [new RegExp(`(?:const|let|var)\\s*\\{[^}]*?\\b(?:(\\w+)\\s*:\\s*)?${name}\\b[^}]*\\}\\s*=\\s*require\\(\\s*${q}\\s*\\)`), (m) => m[1] ?? found],
    ];
    for (const [re, exported] of imports) {
      const m = re.exec(src);
      if (!m) continue;
      const target = resolveImport(dir, entry, m[m.length - 1]);
      if (!target) continue;
      const targetSrc = readFileSync(join(dir, target), 'utf8');
      if (!BUILDS_APP.test(targetSrc)) continue;
      return { ...describe(target, targetSrc, framework), exportName: exported(m) };
    }
  }
  return null;
}

/** Paths a Worker compares its URL against (`pathname === '/admin'`, `case '/mcp':`), as routes to start from: GET unless the line says otherwise. */
function workerRoutes(dir: string, main: string): string[] {
  const root = dirname(join(dir, main));
  const files = [join(dir, main), ...(existsSync(root) ? readdirSync(root, { recursive: true }).map((f) => join(root, String(f))) : [])].filter((f) => /\.[cm]?[jt]s$/.test(f) && !/node_modules|\.test\./.test(f) && existsSync(f) && statSync(f).isFile());
  const routes = new Set<string>();
  for (const f of new Set(files)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      // A method compared on the same line (`pathname === '/signup' && req.method === 'POST'`) is the route's.
      const method = /\.method\s*===?\s*['"`]([A-Z]+)['"`]/.exec(line)?.[1] ?? 'GET';
      for (const m of line.matchAll(/(?:pathname\s*===?\s*|case\s+)['"`](\/[\w\-./]*)['"`]/g)) routes.add(`${method} ${m[1]}`);
    }
  }
  return [...routes].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]));
}

/** Whether a Worker's own code uses HTMLRewriter, which needs html-rewriter-wasm under Oodle. */
export function usesHtmlRewriter(dir: string, main: string): boolean {
  const root = dirname(join(dir, main));
  return readdirSync(root, { recursive: true }).some((f) => /\.[cm]?[jt]s$/.test(String(f)) && /\bnew HTMLRewriter\b/.test(readFileSync(join(root, String(f)), 'utf8')));
}

/** Whether the project can load a package. */
export function canResolve(dir: string, spec: string): boolean {
  try {
    createRequire(join(dir, 'package.json')).resolve(spec);
    return true;
  } catch {
    return false;
  }
}

/** A Cloudflare Worker: a Wrangler config that names its entry module. */
function detectWorker(dir: string): Service | null {
  const file = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((f) => existsSync(join(dir, f)));
  if (!file) return null;
  let main: unknown;
  try { main = readWrangler(join(dir, file)).config.main; } catch { return null; }
  if (typeof main !== 'string' || !existsSync(join(dir, main))) return null;
  return { entry: main.replace(/^\.\//, ''), framework: 'worker', exportName: 'default', listensOnImport: false, wrangler: file, routes: workerRoutes(dir, main) };
}

/** A Worker's D1 database, from its Wrangler config: Oodle runs it as SQLite (0017). */
function workerDatabase(dir: string, svc: Service): DatabaseFound | undefined {
  const d1 = readWrangler(join(dir, svc.wrangler!)).config.d1_databases?.[0];
  if (!d1) return undefined;
  const schema = d1.migrations_dir ?? 'migrations';
  return { driver: 'd1', engine: 'sqlite', env: [], ...(existsSync(join(dir, schema)) ? { schema } : {}) };
}

/** Finds an existing HTTP service in `dir`, so `oodle init` can wrap it instead of writing a starter app. */
export function detectService(dir: string): Service | null {
  const worker = detectWorker(dir);
  if (worker) return worker;
  const pkg = readJson(join(dir, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  // A Next.js app: Oodle runs its App Router route handlers (see src/next.ts).
  if ('next' in deps) {
    const appDir = ['app', 'src/app'].find((d) => existsSync(join(dir, d)));
    if (appDir) return { entry: appDir, framework: 'next', exportName: 'default', listensOnImport: false, esm: pkg?.type === 'module' };
  }
  const framework = FRAMEWORKS.find((f) => f in deps);
  const fromPkg = [pkg?.main, /(?:node|tsx|ts-node|bun)\s+(?:--\S+\s+)*([\w./-]+\.[cm]?[jt]s)\b/.exec(pkg?.scripts?.start ?? pkg?.scripts?.dev ?? '')?.[1]]
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, existsSync(join(dir, x.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'))) ? '.ts' : '.js'));
  const candidates = [...fromPkg, ...ENTRY_NAMES.flatMap((n) => ENTRY_EXTS.map((e) => n + e))];
  for (const entry of candidates) {
    const path = join(dir, entry);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, 'utf8');
    if (src.includes(STARTER_MARK) || !SERVER_CODE.test(src)) continue;
    const own = describe(entry, src, framework);
    // An entry that only starts the app (`import { app } from './app'; app.listen(3000)`) points at the module that builds it.
    if (!own.exportName && own.listensOnImport) {
      const built = followListen(dir, entry, src, framework);
      if (built) return built;
    }
    return own;
  }
  return null;
}

/** Files that mark a stack Oodle can't run, and what to call it. */
const STACKS: [string[], string][] = [
  [['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'], 'a Cloudflare Worker whose Wrangler config names no main module'],
  [['deno.json', 'deno.jsonc'], 'a Deno app'],
  [['pyproject.toml', 'requirements.txt', 'Pipfile'], 'a Python app'],
  [['go.mod'], 'a Go service'],
  [['Gemfile'], 'a Ruby app'],
  [['Cargo.toml'], 'a Rust service'],
  [['pom.xml', 'build.gradle', 'build.gradle.kts'], 'a JVM service'],
  [['composer.json'], 'a PHP app'],
  [['mix.exs'], 'an Elixir app'],
];

/** Code Oodle found but can't run: a stack it doesn't support, or a src/ with no server it recognises. */
export interface Stack {
  /** The file that gave it away, relative to the project. */
  file: string;
  what: string;
}

/** What else is in `dir` when no service is: so init never drops a starter app beside code it can't see. */
export function detectStack(dir: string): Stack | null {
  for (const [files, what] of STACKS) {
    const file = files.find((f) => existsSync(join(dir, f)));
    if (file) return { file, what };
  }
  const src = join(dir, 'src');
  const code = existsSync(src) && readdirSync(src, { recursive: true }).some((f) => /\.[cm]?[jt]sx?$/.test(String(f)) && !readFileSync(join(src, String(f)), 'utf8').includes(STARTER_MARK));
  return code ? { file: 'src/', what: 'code with no Express, Fastify, Koa, Hono, Next.js or node:http server Oodle recognises' } : null;
}

/** What the generated adapter says about the database, instead of the setup(ctx) example. */
const DB_NOTE = (db: DatabaseFound) => `  // ${db.driver} needs nothing here: \`database\` in oodlc/config.yaml gives the app a real Postgres on
  // ${db.env.join(', ')}, seeded from given.db before each run. setup(ctx) is for other module-level state.
`;

const NEXT_ADAPTER = (svc: Service, calls: OutboundCall[], db?: DatabaseFound) => `/**
 * How Oodle runs your Next.js app: every route handler in ${svc.entry}/, behind middleware.ts, in process,
 * in a sealed simulation. No build, no server, no port. Next's own route module runs each handler, so
 * cookies(), headers(), redirect() and notFound() behave as they do in Next. Pages aren't run: outcomes
 * describe what a caller gets from your routes.
 *
 * Every outbound HTTP call (fetch, an SDK, Supabase, Stripe) must be named under \`effects\`, and each
 * effect kind gets a stub in oodlc/config.yaml. Anything not named is refused and reported as a blocking
 * \`oodle.sealed\` violation.
 *
 * Environment: Oodle loads .env.test and .env the way Next's test mode does, never .env.local, so your
 * laptop and CI see the same values. Commit a .env.test with placeholder values your modules need to load.
 *
 * Then: \`oodle doctor\`. Docs: https://github.com/oodlc/oodle#nextjs
 */
import { nextApp } from '@oodlc/oodle/next';

export default nextApp({
  dir: ${svc.esm ? 'import.meta.dirname' : '__dirname'},
  // Outbound calls, by "METHOD host/path-prefix" or "host". The most specific match wins.${calls.length ? '\n  // Found by `oodle init`. Split one by path or method when it does several things, e.g. \'POST api.stripe.com/v1/charges\': \'payment.charge\'.' : ''}
  effects: {
${effectLines(calls, ["'GET your-project.supabase.co/rest/v1/orders': 'db.orders.read',", "'POST api.stripe.com/v1/charges': 'payment.charge',"])}  },
${db ? DB_NOTE(db) : `  // Runs before each simulated run. Point module-level stores at ctx.state here,
  // so every outcome starts from the state it declares.
`}});
`;

const ADAPTER = (svc: Service, calls: OutboundCall[], db?: DatabaseFound) => {
  const spec = `./${svc.entry}`;
  const name = svc.exportName && svc.exportName !== 'default' ? svc.exportName : 'app';
  const importLine = !svc.exportName
    ? `import ${name} from '${spec}'; // TODO: export the app from ${svc.entry}, e.g. \`export const app = ${svc.framework === 'node' ? 'http.createServer(handler)' : `${svc.framework}()`}\``
    : svc.exportName === 'default' ? `import ${name} from '${spec}';` : `import { ${name} } from '${spec}';`;
  const target = svc.framework === 'fastify' ? `${name}.ready().then(() => ${name}.server)` : name;
  const todo: string[] = [];
  if (svc.listensOnImport) todo.push(` * - ${svc.entry} calls listen() when it is imported. Only listen when run directly, e.g.\n *   \`if (import.meta.main) ${name}.listen(port)\` (ESM) or \`if (require.main === module) ...\` (CommonJS).`);
  if (!svc.exportName) todo.push(` * - ${svc.entry} doesn't seem to export the app. Export it, then fix the import below.`);
  if (svc.framework === 'fastify') todo.push(' * - Fastify routes aren\'t found on their own: list them under `routes`.');
  return `/**
 * How Oodle runs your service: the real ${svc.framework === 'node' ? 'HTTP' : svc.framework} app from ${svc.entry}, in process, in a
 * sealed simulation. No port opens and nothing leaves: every outbound HTTP call
 * (fetch, axios, an SDK) must be named under \`effects\`, and each effect kind gets a stub in oodlc/config.yaml.
 * Anything not named is refused and reported as a blocking \`oodle.sealed\` violation.
 *${todo.length ? `\n * Before the first run:\n${todo.join('\n')}\n *` : ''}
 * Then: \`oodle doctor\`. Docs: https://github.com/oodlc/oodle#adopting-an-existing-service
 */
import { httpApp } from '@oodlc/oodle/adapter';
${importLine}

export default httpApp(${target}, {
  // Outbound calls, by "METHOD host/path-prefix" or "host". The most specific match wins.${calls.length ? '\n  // Found by `oodle init`. Split one by path or method when it does several things, e.g. \'POST api.stripe.com/v1/charges\': \'payment.charge\'.' : ''}
  effects: {
${effectLines(calls, ["'POST api.stripe.com/v1/charges': 'payment.charge',", "'api.sendgrid.com': 'email.sent',"])}  },
${db ? DB_NOTE(db) : `  // Runs before each simulated run. Point module-level stores at ctx.state here,
  // so every outcome starts from the state it declares, e.g.:
  //   setup(ctx) { db.users = new Map(Object.entries(ctx.state.users ?? {})); },
`}});
`;
};

const WORKER_ADAPTER = (svc: Service, calls: OutboundCall[]) => `/**
 * How Oodle runs your Cloudflare Worker: its own fetch handler from ${svc.entry}, in process, in a sealed
 * simulation, with env built from ${svc.wrangler}. No workerd, no port. D1 is SQLite in process,
 * KV lives in given.state, static assets are served as Cloudflare serves them, and every other binding
 * (send_email, queues, services, R2, …) records each call as an effect named <binding>.<method>.
 * Outbound fetch calls must be named under \`effects\`, and each effect kind gets a stub in oodlc/config.yaml.
 *
 * Then: \`oodle doctor\`. Docs: https://oodlc.com/docs/guide#cloudflare-workers
 */
import { workerApp } from '@oodlc/oodle/workers';

export default await workerApp(() => import('./${svc.entry}'), {
  wrangler: new URL('./${svc.wrangler}', import.meta.url),
  // A Worker has no route table. These are the paths its code compares against, GET unless the same
  // line checks the method: check them, and add what's missing, so Oodle can probe the routes nothing describes.
  routes: [${(svc.routes ?? []).map((r) => `'${r}'`).join(', ')}],
  // Secrets the Worker reads, with test values. Never real ones: they'd be in your repository.
  env: {},
  // Outbound fetch calls, by "METHOD host/path-prefix" or "host". The most specific match wins.
  effects: {
${effectLines(calls, ["'POST api.stripe.com/v1/charges': 'payment.charge',", "'api.resend.com': 'email.sent',"])}  },
});
`;

/** Workflow steps that set up the package manager and install the repository's dependencies. */
function installSteps(root: string): string {
  const pm = packageManager(root);
  const node = (cache = '') => `      - uses: actions/setup-node@v7
        with:
          node-version: 22${cache}
`;
  if (pm === 'pnpm') {
    // pnpm/action-setup reads the version from packageManager in package.json, and fails when given both.
    let pinned = false;
    try { pinned = /^pnpm@/.test(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ?? ''); } catch { /* no package.json */ }
    return `      - uses: pnpm/action-setup@v4${pinned ? '' : '\n        with:\n          version: 10'}\n${node('\n          cache: pnpm')}      - run: pnpm install --frozen-lockfile\n`;
  }
  if (pm === 'yarn') {
    const berry = existsSync(join(root, '.yarnrc.yml'));
    return `${node()}      - run: corepack enable\n      - run: yarn install ${berry ? '--immutable' : '--frozen-lockfile'}\n`;
  }
  if (pm === 'bun') return `${node()}      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n`;
  return `${node()}      - run: npm ci\n`;
}

const WORKFLOW = (project: string, root: string) => `# Oodle: outcome diff on every pull request, and approvals from reviews.
# Its own workflow, so a review re-runs only this check. Docs: https://github.com/oodlc/oodle#in-ci
name: Oodle

on:
  pull_request:
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: oodle-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  outcomes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
${installSteps(root)}      - uses: oodlc/oodle@v0
        with:
          project: ${project}
`;

export interface InitResult {
  dir: string;
  created: string[];
  kept: string[];
  /** Files moved by --migrate, as [from, to]. */
  moved?: [string, string][];
  /** The existing service init wrapped, if it found one. */
  service?: Service;
  /** --ci on a project that already existed: only the workflow was written. */
  workflowOnly?: boolean;
  /** Outbound calls init found in the service and named under effects. */
  effects?: OutboundCall[];
  /** The Postgres the service uses, simulated in process when it is one Oodle can serve. */
  database?: DatabaseFound;
  /** --inventory: a project with no app, that explains a system (0011). */
  inventory?: true;
}

/** The GitHub workflow, at the repository root, pointing at the project. */
function workflowFile(dir: string): [string, string, boolean] {
  mkdirSync(dir, { recursive: true });
  let root = dir;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not in git: put it in the project */ }
  // git answers with the real path (macOS: /private/var for /var), so compare real paths.
  const [realRoot, realDir] = [realpathSync(root), realpathSync(dir)];
  return [relative(realDir, join(realRoot, '.github', 'workflows', 'oodle.yml')), WORKFLOW(relative(realRoot, realDir) || '.', realRoot), false];
}

/** Writes each [path, body, overwrite] file. An existing file is kept unless it may be overwritten and --force says so; `keep` is always kept. */
function writeFiles(dir: string, files: [string, string, boolean][], force: boolean, keep?: string): { created: string[]; kept: string[] } {
  const created: string[] = [];
  const kept: string[] = [];
  for (const [rel, body, overwrite] of files) {
    const path = join(dir, rel);
    if ((existsSync(path) && (!overwrite || !force)) || rel === keep) {
      kept.push(rel);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    created.push(rel);
  }
  return { created, kept };
}

export function init(target: string, opts: { app?: string; force?: boolean; ci?: boolean; inventory?: boolean }): InitResult {
  const dir = resolve(target);
  const existing = configFile(dir);
  if (existing?.legacy) {
    throw new OodleError('exists', `${display(existing.path)} is a project in the old layout`, {
      hint: `Move it into ${FOLDER}/ with \`oodle init --migrate${target === '.' ? '' : ` ${target}`}\`.`,
    });
  }
  // CI added to a project that already exists: only the workflow, never the catalog it already has.
  if (existing && !opts.force && opts.ci) return { dir, ...writeFiles(dir, [workflowFile(dir)], false), workflowOnly: true };
  if (existing && !opts.force) {
    throw new OodleError('exists', `${display(existing.path)} already exists`, {
      hint: 'To add the GitHub workflow, use --ci. To start over, --force overwrites the scaffold files; your app is never overwritten.',
    });
  }
  if (opts.inventory) {
    const files: [string, string, boolean][] = [[`${FOLDER}/${CONFIG_FILE}`, INVENTORY_CONFIG, true], [`${FOLDER}/intents.yaml`, INVENTORY_INTENTS, true]];
    if (opts.ci) files.push(workflowFile(dir));
    return { dir, ...writeFiles(dir, files, !!opts.force), inventory: true };
  }
  // An existing service gets an adapter around it, never a starter app beside it.
  const service = opts.app ? null : detectService(dir);
  // A starter app beside code Oodle can't run would pass every check while testing none of it.
  const stack = opts.app || service ? null : detectStack(dir);
  if (stack) {
    throw new OodleError('unsupported-stack', `Found ${stack.file}: ${stack.what}, which Oodle can't run yet`, {
      hint: `Write an adapter that runs it (see https://oodlc.com/docs/guide#the-app-contract) and point init at it with --app <file>, or explain it from evidence with \`oodle init --inventory\`.`,
    });
  }
  const app = opts.app ?? (service ? (service.framework === 'worker' ? 'oodle.app.mts' : 'oodle.app.ts') : 'src/app.ts');
  const hasHealth = !service || (service.framework !== 'next' && /['"`]\/health['"`]/.test(readFileSync(join(dir, service.entry), 'utf8')));
  const calls = service ? scanOutbound(dir) : [];
  const found = service ? (service.framework === 'worker' ? workerDatabase(dir, service) ?? null : scanDatabase(dir)) : null;
  const db = found && !found.unsupported ? found : undefined;
  // The starter app or adapter only fills a gap; an existing file is always left alone, and its effects get the stubs.
  const appExists = existsSync(join(dir, app));
  const kinds = appExists ? declaredEffects(join(dir, app)) : [...new Set(calls.map((c) => c.kind))];
  const files: [string, string, boolean][] = [
    [`${FOLDER}/${CONFIG_FILE}`, CONFIG(app, kinds, db), true],
    [`${FOLDER}/intents.yaml`, INTENTS, true],
    [`${FOLDER}/outcomes.yaml`, hasHealth ? OUTCOMES : OUTCOMES_TODO, true],
    [app, service ? (service.framework === 'next' ? NEXT_ADAPTER(service, calls, db) : service.framework === 'worker' ? WORKER_ADAPTER(service, calls) : ADAPTER(service, calls, db)) : APP, false],
  ];
  if (opts.ci) files.push(workflowFile(dir));
  const { created, kept } = writeFiles(dir, files, !!opts.force, opts.app ? app : undefined);
  return { dir, created, kept, ...(service ? { service } : {}), ...(service && !appExists ? { effects: calls } : {}), ...(found ? { database: found } : {}) };
}

/** Moves a file with `git mv` when git tracks it, so history follows; otherwise renames it. */
function move(dir: string, from: string, to: string): void {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', from], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['mv', from, to], { cwd: dir, stdio: 'ignore' });
  } catch {
    renameSync(join(dir, from), join(dir, to));
  }
}

/** Moves a v0 project (oodle.yaml plus a catalog directory) into oodlc/. See docs/decisions/0003. */
export function migrate(target: string): InitResult {
  const dir = resolve(target);
  const where = configFile(dir);
  if (!where) throw new OodleError('no-project', `No project in ${display(dir)} to migrate`, { hint: 'Start one with `oodle init`.' });
  if (!where.legacy) throw new OodleError('exists', `${display(dir)} already uses ${FOLDER}/`, { hint: 'Nothing to migrate.' });

  const text = readFileSync(where.path, 'utf8');
  const catalogDir = String(parse(text)?.catalog ?? 'catalog');
  const files = existsSync(join(dir, catalogDir)) ? readdirSync(join(dir, catalogDir)).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (files.includes(CONFIG_FILE)) {
    throw new OodleError('migrate-conflict', `${catalogDir}/${CONFIG_FILE} would collide with the config file`, { hint: 'Rename that catalog file, then migrate again.' });
  }

  const moved: [string, string][] = [];
  for (const f of files) {
    const from = join(catalogDir, f);
    const to = join(FOLDER, f);
    if (from === to) continue;
    move(dir, from, to);
    moved.push([from, to]);
  }
  // The config keeps its comments and settings; only the catalog key goes, since oodlc/ is the catalog now.
  move(dir, 'oodle.yaml', join(FOLDER, CONFIG_FILE));
  writeFileSync(join(dir, FOLDER, CONFIG_FILE), text.replace(/^catalog:.*\r?\n/m, ''));
  moved.push(['oodle.yaml', join(FOLDER, CONFIG_FILE)]);
  try {
    if (catalogDir !== FOLDER) rmdirSync(join(dir, catalogDir));
  } catch { /* not empty: other files stay where they were */ }
  return { dir, created: [], kept: [], moved };
}
