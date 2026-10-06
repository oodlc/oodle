import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runProject } from '../src/runner.ts';
import { diffRuns } from '../src/diff.ts';
import { diffMarkdown } from '../src/report.ts';
import { OodleError } from '../src/errors.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EXAMPLE = join(ROOT, 'examples', 'postgres-orders');

/** Links Oodle's node_modules (and Oodle itself) into a project in a temp dir, so its app loads as if installed. */
function install(dir: string) {
  mkdirSync(join(dir, 'node_modules', '@oodlc'), { recursive: true });
  for (const name of readdirSync(join(ROOT, 'node_modules'))) {
    if (name.startsWith('.') || name === '@oodlc') continue;
    symlinkSync(join(ROOT, 'node_modules', name), join(dir, 'node_modules', name));
  }
  symlinkSync(ROOT, join(dir, 'node_modules', '@oodlc', 'oodle'));
}

function copyExample(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-db-')), 'postgres-orders');
  cpSync(EXAMPLE, dir, { recursive: true });
  install(dir);
  return dir;
}

/** A project from scratch: `files` by path, relative to the project root. */
function project(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'oodle-db-')), 'app');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  install(dir);
  return dir;
}

function edit(dir: string, file: string, from: string | RegExp, to: string) {
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(after, before, `edit did not apply to ${file}`);
  writeFileSync(path, after);
}

async function diffAfter(mutate: (dir: string) => void) {
  const head = copyExample();
  mutate(head);
  const report = diffRuns(await runProject(EXAMPLE), await runProject(head));
  return { report, byId: (id: string) => report.outcomes.find((o) => o.id === id)! };
}

const dbEffects = (effects: { kind: string }[]) => effects.filter((e) => e.kind.startsWith('db.'));

test('database: an Express service on pg runs against a real Postgres, and every row it writes is an effect', async () => {
  const run = await runProject(EXAMPLE);
  assert.deepEqual(run.observations.filter((o) => o.failures.length || o.violations.length), []);
  assert.equal(run.gaps.length, 0);
  const paid = run.observations.find((o) => o.id === 'orders.paid-with-receipt')!;
  const order = { id: '00000000-0000-4000-8000-000000000001', user_id: 'u1', amount_cents: 1800, created_at: '2026-01-01T00:00:00+00:00' };
  assert.deepEqual(dbEffects(paid.effects), [
    { kind: 'db.orders.inserted', boundary: 'data', payload: { ...order, status: 'pending', charge_id: null } },
    { kind: 'db.orders.updated', boundary: 'data', payload: { ...order, status: 'paid', charge_id: 'ch_1' }, result: { status: 'pending', charge_id: null } },
  ]);
  // The pro discount comes from a row the migrations inserted, so reference data is there on every run.
  assert.equal((paid.body as { amountCents: number }).amountCents, 1800);
  // A rolled-back transaction wrote nothing.
  assert.deepEqual(dbEffects(run.observations.find((o) => o.id === 'orders.declined-leaves-no-order')!.effects), []);
});

test('database: time, uuids and serial ids are deterministic, and a second run in the same process finds the same database', async () => {
  const strip = (r: Awaited<ReturnType<typeof runProject>>) => r.observations.map((o) => [o.id, o.condition, o.status, o.body, o.effects]);
  const before = process.env.DATABASE_URL;
  assert.deepEqual(strip(await runProject(EXAMPLE)), strip(await runProject(EXAMPLE)));
  assert.equal(process.env.DATABASE_URL, before, 'DATABASE_URL is given back after the run');
});

test('database: a storage-only change is behavior; outcomes hold and nothing blocks', async () => {
  const { report, byId } = await diffAfter((dir) => {
    writeFileSync(join(dir, 'db/migrations/0003_currency.sql'), "ALTER TABLE orders ADD COLUMN currency text NOT NULL DEFAULT 'usd';\n");
  });
  assert.equal(report.blocking, 0, JSON.stringify(report.outcomes, null, 2));
  const paid = byId('orders.paid-with-receipt');
  assert.equal(paid.status, 'held');
  assert.ok(paid.behavior.some((b) => b.includes('db.orders.inserted') && b.includes('currency added')), paid.behavior.join('\n'));
  assert.match(diffMarkdown(report), /behavior changes/);
});

test('database: a write that silently stops happening breaks the outcome that expects it, even when the response looks right', async () => {
  const { report, byId } = await diffAfter((dir) => {
    edit(dir, 'src/server.ts', "const { rows: [refunded] } = await pool.query(`UPDATE orders SET status = 'refunded' WHERE id = $1 RETURNING id, status`, [order.id]);", "const refunded = { id: order.id, status: 'refunded' };");
  });
  const refund = byId('orders.refund-returns-money');
  assert.equal(refund.status, 'broken');
  assert.ok(refund.details.some((d) => d.includes('effect db.orders.updated') && d.includes('expected 1, got 0')), refund.details.join('\n'));
  assert.equal(report.blocking, 1);
});

test('database: constraints see every table after the run as db, on outcomes, behaviors and probes', async () => {
  const { report } = await diffAfter((dir) => {
    edit(dir, 'src/server.ts', "await pool.query('SELECT 1');", "await pool.query(\"UPDATE orders SET status = 'paid'\");");
    writeFileSync(join(dir, 'oodlc/health-seed.yaml'), `version: 0
conditions:
  - id: pending_order
    given:
      db:
        orders:
          - { user_id: u1, amount_cents: 500 }
`);
    edit(dir, 'oodlc/orders.yaml', /    trigger:\n      http: GET \/health\n/, '    trigger:\n      http: GET /health\n    conditions: [pending_order]\n');
  });
  const health = report.behaviors.find((b) => b.id === 'ops.health')!;
  assert.equal(health.blocking, true);
  assert.ok(health.violations.some((v) => v.includes('no-paid-order-without-charge violated')), health.violations.join('\n'));
});

test('database: request input pasted into SQL is refused, blocks as oodle.sql-injection, and leaves the database intact', async () => {
  const { report, byId } = await diffAfter((dir) => {
    edit(dir, 'src/server.ts', "u.plan WHERE u.id = $1',\n    [userId],", "u.plan WHERE u.id = '` + userId + `'`,");
    edit(dir, 'src/server.ts', "'SELECT u.id, u.email", "`SELECT u.id, u.email");
  });
  const hostile = byId('orders.hostile-input-charges-nobody');
  assert.equal(hostile.status, 'broken');
  assert.ok(hostile.details.some((d) => d.includes('oodle.sql-injection violated') && d.includes("WHERE u.id = '' OR '1'='1'")), hostile.details.join('\n'));
  // The injected DROP TABLE never ran: every other outcome still holds against the same database.
  assert.deepEqual(report.outcomes.filter((o) => o.status !== 'held').map((o) => o.id), ['orders.hostile-input-charges-nobody']);
});

test('database: a new route nobody describes is probed against the database, and what it wrote is in the probe', async () => {
  const { report } = await diffAfter((dir) => {
    edit(dir, 'src/server.ts', "app.post('/orders/:id/refund'", `app.post('/users', async (req, res) => {
  const { rows: [user] } = await pool.query('INSERT INTO users (id, email) VALUES ($1, $2) RETURNING id, plan', [req.body?.id ?? 'u2', req.body?.email ?? 'new@example.com']);
  res.status(201).json(user);
});

app.post('/orders/:id/refund'`);
  });
  const gap = report.gaps.find((g) => g.route === 'POST /users')!;
  assert.equal(gap.probe.status, 201);
  assert.deepEqual(dbEffects(gap.probe.effects!), [{ kind: 'db.users.inserted', boundary: 'data', payload: { id: 'u2', email: 'new@example.com', plan: 'free' } }]);
  assert.deepEqual(gap.violations, []);
  assert.equal(report.blocking, 0);
});

test('database: a row written without credentials is a side effect, so the security pack catches a route that does it', async () => {
  const { report } = await diffAfter((dir) => {
    edit(dir, 'src/server.ts', "app.post('/orders/:id/refund'", `app.post('/users', async (req, res) => {
  await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', ['u2', 'new@example.com']);
  res.status(201).json({ ok: true });
});

app.post('/orders/:id/refund'`);
    edit(dir, 'oodlc/config.yaml', 'conditions: [security.injection]', 'conditions: [security.injection, security.no-credentials]');
    writeFileSync(join(dir, 'oodlc/security.yaml'), `version: 0
constraints:
  - id: no-side-effects-without-credentials
    statement: A request with no credentials changes nothing, inside or out
    check: "!!(request.headers && request.headers.authorization) || effects.every(e => e.boundary === 'internal')"
`);
  });
  const gap = report.gaps.find((g) => g.route === 'POST /users')!;
  assert.ok(gap.violations.some((v) => v.startsWith('[security.no-credentials] constraint no-side-effects-without-credentials violated')), gap.violations.join('\n'));
});

test('database: given.db names a missing table or column with a suggestion, and the run fails instead of guessing', async () => {
  const tableTypo = copyExample();
  edit(tableTypo, 'oodlc/orders.yaml', '          orders:\n            - { id: 00000000', '          ordrs:\n            - { id: 00000000');
  const refund = (await runProject(tableTypo)).observations.find((o) => o.id === 'orders.refund-returns-money')!;
  assert.match(refund.failures[0], /^given\.db\.ordrs: no such table; did you mean orders\? Tables: orders, plans, users/);
  assert.equal(refund.status, null, 'the app never ran');

  const columnTypo = copyExample();
  edit(columnTypo, 'oodlc/config.yaml', '{ id: u1, email: ada@example.com, plan: pro }', '{ id: u1, emial: ada@example.com, plan: pro }');
  const paid = (await runProject(columnTypo)).observations.find((o) => o.id === 'orders.paid-with-receipt')!;
  assert.match(paid.failures[0], /^given\.db\.users\[0\]\.emial: users has no such column; did you mean email\?/);
});

test('database: given.db without a database is a lint error, not a silent no-op', async () => {
  const dir = copyExample();
  edit(dir, 'oodlc/config.yaml', 'database:\n  schema: db/migrations          # applied once, in name order; every run starts from it\n', '');
  const run = await runProject(dir).catch((e) => e);
  const errors = run instanceof Error ? [run.message] : run.lint.errors;
  assert.ok(errors.some((e: string) => e.includes('given.db seeds a database, but oodlc/config.yaml has no "database"')), errors.join('\n'));
});

test('database: a schema error names the file and line', async () => {
  const dir = copyExample();
  writeFileSync(join(dir, 'db/migrations/0003_broken.sql'), "-- a typo on line 3\n\nALTER TABLE orderz ADD COLUMN note text;\n");
  await assert.rejects(runProject(dir), (err: unknown) => {
    assert.ok(err instanceof OodleError);
    assert.equal(err.code, 'database-schema');
    assert.match(err.problems[0], /db\/migrations\/0003_broken\.sql:3: relation "orderz" does not exist/);
    return true;
  });
});

const POSTGRES_JS_APP = `
import { Hono } from 'hono';
import postgres from 'postgres';
import { httpApp } from '@oodlc/oodle/adapter';

// idle_timeout ends idle connections, and with them postgres.js's max_lifetime timers, so the test process can exit.
const sql = postgres(process.env.DATABASE_URL!, { max: 4, idle_timeout: 1 });
const app = new Hono();
app.post('/notes', async (c) => {
  const { text, tags } = await c.req.json();
  const [note] = await sql\`INSERT INTO notes (body, tags) VALUES (\${text}, \${tags}) RETURNING id, slug\`;
  // Two connections at once, each with its own prepared statements.
  const [[count], [again]] = await Promise.all([sql\`SELECT count(*)::int AS n FROM notes\`, sql\`SELECT body FROM notes WHERE id = \${note.id}\`]);
  return c.json({ ...note, count: count.n, body: again.body }, 201);
});
app.get('/notes', async (c) => c.json(await sql\`SELECT id, body, tags FROM notes ORDER BY id\`));
export default httpApp(app, { routes: ['POST /notes', 'GET /notes'] });
`;

test('database: postgres.js, extensions, Supabase-style grants and multi-file schemas work as they do on a real Postgres', async () => {
  const dir = project({
    'package.json': '{ "type": "module" }',
    'oodle.app.ts': POSTGRES_JS_APP,
    'supabase/migrations/20240101000000_init.sql': `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug uuid NOT NULL DEFAULT uuid_generate_v4(),
  body text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON notes TO anon, authenticated;
`,
    'supabase/migrations/20240102000000_upper.sql': 'ALTER TABLE notes ADD COLUMN shout text GENERATED ALWAYS AS (upper(body)) STORED;\n',
    'oodlc/config.yaml': `app: oodle.app.ts
database:
  schema: supabase/migrations
defaults:
  given:
    db:
      notes:
        - { id: 7, body: seeded, tags: [a, b] }
`,
    'oodlc/notes.yaml': `version: 0
intents:
  - { id: keep-notes, statement: People can write things down and find them again }
outcomes:
  - id: notes.saved
    intent: keep-notes
    statement: A saved note gets the next id and is there to read back
    boundary: customer
    trigger:
      http: POST /notes
      given: { body: { text: hello, tags: [x] } }
    expect:
      status: 201
      body: { id: "8", count: 2, body: hello, slug: 00000000-0000-4000-8000-000000000002 }
      effects:
        - { kind: db.notes.inserted, match: { body: hello, shout: HELLO, tags: [x], created_at: "2026-01-01T00:00:00+00:00" }, count: 1 }
  - id: notes.listed
    intent: keep-notes
    statement: Notes are listed with their tags
    boundary: customer
    trigger: { http: GET /notes }
    expect:
      status: 200
      body: { "0": { id: "7", body: seeded, tags: [a, b] } }
`,
  });
  const run = await runProject(dir);
  assert.deepEqual(run.observations.flatMap((o) => [...o.failures, ...o.violations]), []);
  const again = await runProject(dir);
  assert.deepEqual(again.observations.map((o) => o.body), run.observations.map((o) => o.body));
});
