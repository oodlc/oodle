import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseToml, readWrangler } from '../src/workers.ts';
import { runProject } from '../src/runner.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oodle.js');
const WORKERS = pathToFileURL(join(ROOT, 'src', 'workers.ts')).href;
const [major, minor] = process.versions.node.split('.').map(Number);
// D1 runs on node:sqlite, which Node has without a flag from 22.13.
const sqlite = major > 22 || (major === 22 && minor >= 13);

test('wrangler.toml: tables, arrays of tables, inline tables, strings and comments', () => {
  const config = parseToml(`
name = "cards" # the worker
main = "src/index.ts"
compatibility_flags = ["nodejs_compat"]
assets = { directory = "./public", binding = "ASSETS" }

[vars]
SITE_NAME = "Cards"
LIMIT = 10
BETA = false

[[d1_databases]]
binding = "DB"
database_name = 'cards'
migrations_dir = "db/migrations"

[[send_email]]
name = "EMAIL"

[[rules]]
type = "Text"
globs = [
  "**/*.md",
  "**/*.yaml",
]
`);
  assert.deepEqual(config, {
    name: 'cards',
    main: 'src/index.ts',
    compatibility_flags: ['nodejs_compat'],
    assets: { directory: './public', binding: 'ASSETS' },
    vars: { SITE_NAME: 'Cards', LIMIT: 10, BETA: false },
    d1_databases: [{ binding: 'DB', database_name: 'cards', migrations_dir: 'db/migrations' }],
    send_email: [{ name: 'EMAIL' }],
    rules: [{ type: 'Text', globs: ['**/*.md', '**/*.yaml'] }],
  });
});

test('wrangler.jsonc: comments and trailing commas, and a // inside a string is not one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oodle-wrangler-'));
  writeFileSync(join(dir, 'wrangler.jsonc'), '{\n  // the worker\n  "name": "cards", /* inline */\n  "routes": [{ "pattern": "https://cards.example/*" },],\n}\n');
  assert.deepEqual(readWrangler(join(dir, 'wrangler.jsonc')).config, { name: 'cards', routes: [{ pattern: 'https://cards.example/*' }] });
});

test('the example Worker: D1, KV, email, assets, HTMLRewriter and the host, all in process', { skip: !sqlite && 'needs node:sqlite (Node 22.13+)' }, async () => {
  const run = await runProject(join(ROOT, 'examples', 'worker-cards'));
  assert.deepEqual(run.observations.flatMap((o) => [...o.failures, ...o.violations].map((f) => `${o.id}: ${f}`)), []);
  const signup = run.observations.find((o) => o.id === 'signup.one-welcome')!;
  // The email, sent through ctx.waitUntil, still counts; the row is a write on the data boundary.
  assert.deepEqual(signup.effects.map((e) => [e.kind, e.boundary]), [['EMAIL.send', 'external'], ['db.signups.inserted', 'data']]);
  assert.deepEqual(signup.effects[0].payload, { from: 'hello@cards.example', to: 'ada@example.com', raw: 'Subject: Welcome to Cards\r\n\r\nThanks for signing up.' });
  const library = run.observations.find((o) => o.id === 'library.live-cards-only')!;
  assert.match(String(library.body), /<footer>Cards, a library of short reads\.<\/footer><\/main>/);
});

/** A Worker in a folder with no package.json, so tsx loads it through require, as many Wrangler projects are. */
function workerProject(worker: string, catalog: string, wrangler: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'oodle-worker-'));
  mkdirSync(join(dir, 'oodlc'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', '0001.sql'), "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);\nINSERT INTO notes (body) VALUES ('first');\n");
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify({ name: 'notes', main: 'index.ts', d1_databases: [{ binding: 'DB', database_name: 'notes' }], kv_namespaces: [{ binding: 'KV' }], services: [{ binding: 'AUTH', service: 'auth' }], rules: [{ type: 'Text', globs: ['**/*.md'] }], ...wrangler }));
  writeFileSync(join(dir, 'index.ts'), worker);
  writeFileSync(join(dir, 'greeting.md'), 'Hello');
  writeFileSync(join(dir, 'oodle.app.mts'), `import { workerApp } from '${WORKERS}';\nexport default await workerApp(() => import('./index.ts'), { wrangler: new URL('./wrangler.json', import.meta.url), routes: ['GET /notes', 'POST /notes'] });\n`);
  writeFileSync(join(dir, 'oodlc', 'config.yaml'), 'app: oodle.app.mts\ndatabase: { engine: sqlite, schema: migrations }\ndefaults:\n  given:\n    stubs:\n      AUTH.fetch: { result: { user: u1 } }\n');
  writeFileSync(join(dir, 'oodlc', 'notes.yaml'), `version: 0\nintents: [{ id: notes, statement: People keep notes }]\n${catalog}`);
  return dir;
}

const NOTES = `import { WorkerEntrypoint } from 'cloudflare:workers';
import greeting from './greeting.md';
export default class extends WorkerEntrypoint {
  async fetch(req) {
    const url = new URL(req.url);
    const who = await (await this.env.AUTH.fetch('https://auth/whoami')).json();
    if (req.method === 'POST') {
      const { body, tag } = await req.json();
      const [, row] = await this.env.DB.batch([
        this.env.DB.prepare('UPDATE notes SET done = 1 WHERE id = ?').bind(1),
        this.env.DB.prepare('INSERT INTO notes (body) VALUES (?) RETURNING id').bind(body),
      ]);
      await this.env.KV.put('last', String(row.results[0].id));
      if (tag) await this.env.DB.prepare("SELECT * FROM notes WHERE body = '" + tag + "'").all();
      return Response.json({ id: row.results[0].id, by: who.user }, { status: 201 });
    }
    const count = await this.env.DB.prepare('SELECT count(*) AS n FROM notes').first('n');
    const [names] = await this.env.DB.prepare('SELECT body FROM notes ORDER BY id').raw({ columnNames: true });
    return Response.json({ count, names, last: await this.env.KV.get('last'), greeting });
  }
}
`;

const NOTES_CATALOG = `outcomes:
  - id: notes.add
    intent: notes
    statement: Adding a note keeps it and marks the first one done
    boundary: customer
    trigger: { http: POST /notes, given: { body: { body: second } } }
    expect:
      status: 201
      body: { id: 2, by: u1 }
      effects:
        - { kind: AUTH.fetch, count: 1 }
        - { kind: db.notes.inserted, match: { body: second }, count: 1 }
        - { kind: db.notes.updated, match: { id: 1, done: 1 }, count: 1 }
  - id: notes.list
    intent: notes
    statement: The list counts the seeded notes and reads KV
    boundary: customer
    trigger: { http: GET /notes, given: { db: { notes: [{ id: 7, body: a }, { id: 8, body: b }] }, state: { KV: { last: '8' } } } }
    expect: { status: 200, body: { count: 2, names: [body], last: '8', greeting: Hello } }
constraints:
  - id: kv-matches-db
    statement: The last note in KV is a note in the database
    check: "!state.KV?.last || db.notes.some((n) => String(n.id) === state.KV.last)"
`;

test('a Worker class through require: D1 batch, first and raw, KV in state, a service binding as an effect, and SQL injection refused', { skip: !sqlite && 'needs node:sqlite (Node 22.13+)' }, async () => {
  const run = await runProject(workerProject(NOTES, NOTES_CATALOG));
  assert.deepEqual(run.observations.flatMap((o) => [...o.failures, ...o.violations]), []);

  const hostile = await runProject(workerProject(NOTES, NOTES_CATALOG.replace('body: { body: second }', `body: { body: second, tag: "x' OR '1'='1" }`)));
  const add = hostile.observations.find((o) => o.id === 'notes.add')!;
  assert.match(add.violations.join('\n'), /oodle\.sql-injection violated/);
  // Like D1, the refused statement throws: the Worker never got to answer.
  assert.match(add.error!, /refused by Oodle/);
});

test('init wraps a Worker: an .mts adapter, its routes and methods, and D1 as SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oodle-init-worker-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'db'));
  writeFileSync(join(dir, 'db', '0001.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "w"\nmain = "src/index.ts"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "w"\nmigrations_dir = "db"\n');
  writeFileSync(join(dir, 'src', 'index.ts'), [
    'export default {',
    '  fetch(req) {',
    '    const u = new URL(req.url);',
    "    if (u.pathname === '/a') return new Response('a');",
    "    if (u.pathname === '/b' && req.method === 'POST') return new Response('b');",
    '    switch (u.pathname) {',
    "      case '/c': return new Response('c');",
    '    }',
    "    return new Response('', { status: 404 });",
    '  },',
    '};',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [BIN, 'init', dir, '--json'], { encoding: 'utf8' });
  const made = JSON.parse(r.stdout);
  assert.equal(made.service.framework, 'worker');
  assert.deepEqual(made.created, ['oodlc/config.yaml', 'oodlc/intents.yaml', 'oodlc/outcomes.yaml', 'oodle.app.mts']);
  const adapter = readFileSync(join(dir, 'oodle.app.mts'), 'utf8');
  assert.match(adapter, /workerApp\(\(\) => import\('\.\/src\/index\.ts'\)/);
  assert.match(adapter, /routes: \['GET \/a', 'POST \/b', 'GET \/c'\]/);
  assert.match(readFileSync(join(dir, 'oodlc', 'config.yaml'), 'utf8'), /database:\n  engine: sqlite\n  schema: db\n/);
});
