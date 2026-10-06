/**
 * The simulated database. With `database:` in oodlc/config.yaml, Oodle runs a
 * real Postgres (PGlite: Postgres compiled to WebAssembly) inside its own
 * process and points the app at it through DATABASE_URL. The app's own driver
 * (pg, postgres.js, and what is built on them: Drizzle, Kysely, Knex, Prisma's pg
 * adapter) connects as it does in production. The seal routes that connection
 * to a Unix socket served by this process: no port opens, no Docker, nothing
 * leaves the machine.
 *
 * Every run starts from the same database: the schema, the rows its migrations
 * insert, and the rows the run's `given.db` names. Each row the app writes is
 * recorded, in order, as an effect on the data boundary (`db.orders.inserted`,
 * `.updated`, `.deleted`, `.truncated`): the outcome diff reports it as behavior,
 * an outcome can expect it, and a constraint can tell a write happened. Constraints see every table after the run as `db`.
 * Time, uuids, random() and serial ids are deterministic.
 *
 * A statement whose text carries the security pack's injection payload means
 * request input was pasted into SQL instead of sent as a parameter. It is
 * refused, so nothing runs, and recorded as a violation of the built-in
 * `oodle.sql-injection` constraint. See docs/decisions/0009.
 */
import net from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Config, EffectRecord } from './types.ts';
import { OodleError, suggest } from './errors.ts';
import { stableStringify } from './expect.ts';
import { routeConnections } from './seal.ts';
import { INJECTION_SQL } from './security.ts';

export const SQL_INJECTION_ID = 'oodle.sql-injection';
const PORT = 5432;
export const DATABASE_URL = `postgresql://postgres:postgres@localhost:${PORT}/postgres?sslmode=disable`;
/** The hosts a driver uses for "this machine". A connect to any of them on PORT reaches the simulated database. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
/** How long a connection waits for another connection's transaction before its query fails. */
const WAIT_MS = 5000;
const PGLITE = '@electric-sql/pglite';

/** The part of PGlite Oodle uses. Loaded from the project, so it is not a dependency of Oodle itself. */
interface PGlite {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>;
  isInTransaction(): boolean;
  close(): Promise<void>;
}

interface Table {
  /** `orders` in public, `billing.orders` elsewhere: the name in given.db, effect kinds and `db`. */
  key: string;
  /** The quoted, schema-qualified name for SQL. */
  ident: string;
  /** Columns a row can set: every column except generated ones. */
  cols: string[];
  /** Sequences owned by a column, to move past seeded ids. */
  seqs: { seq: string; col: string }[];
}

// ── Schema ──────────────────────────────────────────────────────────────────

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (text: string) => `'${text.replace(/'/g, "''")}'`;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('.') || d.name === 'node_modules') return [];
    const p = join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

/**
 * The SQL files a `database.schema` entry names: a file, or every .sql file under a folder in name
 * order, which is migration order for Prisma, Drizzle, golang-migrate, dbmate and Supabase alike.
 * Down migrations are skipped.
 */
export function schemaFiles(projectDir: string, schema: string | string[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of [schema ?? []].flat()) {
    const abs = resolve(projectDir, entry);
    if (!existsSync(abs)) {
      throw new OodleError('database-schema', `database.schema: ${entry} not found`, {
        hint: 'Point database.schema in oodlc/config.yaml at a .sql file or a folder of migrations, relative to the project root.',
      });
    }
    if (!statSync(abs).isDirectory()) {
      out.push(abs);
      continue;
    }
    const files = walk(abs)
      .filter((f) => /\.sql$/i.test(f) && !/(^|[._-])down\.sql$/i.test(f.split(/[\\/]/).pop()!))
      .map((f) => ({ f, key: relative(abs, f).split(/[\\/]/).join('/') }))
      .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
    out.push(...files.map((x) => x.f));
  }
  return out;
}

/** A dbmate migration keeps its down half in the same file, after `-- migrate:down`. */
const upHalf = (sql: string) => sql.split(/^--\s*migrate:down\b/m)[0];

/** Extensions the schema creates, as PGlite names them: "uuid-ossp" is uuid_ossp. */
function extensionsIn(sql: string): string[] {
  const names = [...sql.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([a-z0-9_-]+))/gi)].map((m) => (m[1] ?? m[2]).toLowerCase().replace(/-/g, '_'));
  return [...new Set(names)].filter((n) => n !== 'plpgsql');
}

/** Resolves a package from the project first, then from Oodle's own install. */
function resolver(projectDir: string) {
  const bases = [join(projectDir, 'package.json'), import.meta.url];
  return (spec: string): string | null => {
    for (const base of bases) {
      try { return createRequire(base).resolve(spec); } catch { /* try the next one */ }
    }
    return null;
  };
}

/** Whether the project itself can load PGlite (Oodle doesn't ship it). */
export function hasPGlite(projectDir: string): boolean {
  try {
    createRequire(join(projectDir, 'package.json')).resolve(PGLITE);
    return true;
  } catch {
    return false;
  }
}

/**
 * The line a Postgres error points at: its position (a 1-based character offset) for a syntax
 * error, or else the first line naming what it complains about, e.g. relation "orderz".
 */
function lineOf(sql: string, err: { message: string; position?: unknown }): number | undefined {
  if (Number(err.position) > 0) return sql.slice(0, Number(err.position) - 1).split('\n').length;
  const name = /"([^"]+)"/.exec(err.message)?.[1];
  if (!name) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = sql.split('\n').findIndex((l) => !/^\s*--/.test(l) && new RegExp(`(^|[^\\w])"?${escaped}"?([^\\w]|$)`, 'i').test(l));
  return at >= 0 ? at + 1 : undefined;
}

/**
 * Oodle's own corner of the database, created before the schema: deterministic uuids (built-ins
 * replaced, so a default written as `pg_catalog.gen_random_uuid()` is covered too), and the
 * change log the per-table triggers write to.
 */
const PRELUDE = `
SET TIME ZONE 'UTC';
CREATE SCHEMA oodle;
CREATE SEQUENCE oodle.uuid_seq;
CREATE FUNCTION oodle.next_uuid(version text) RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT ((CASE version WHEN '7' THEN '01940000-0000-7000-8000-' ELSE '00000000-0000-4000-8000-' END) || lpad(to_hex(nextval('oodle.uuid_seq')), 12, '0'))::uuid
$$;
CREATE OR REPLACE FUNCTION pg_catalog.gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT oodle.next_uuid('4') $$;
CREATE OR REPLACE FUNCTION pg_catalog.uuidv4() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT oodle.next_uuid('4') $$;
CREATE OR REPLACE FUNCTION pg_catalog.uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT oodle.next_uuid('7') $$;
CREATE TABLE oodle.changes (seq bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, old jsonb, new jsonb);
CREATE FUNCTION oodle.record_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO oodle.changes (tbl, op, old, new) VALUES (TG_ARGV[0], TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$;
CREATE FUNCTION oodle.record_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO oodle.changes (tbl, op) VALUES (TG_ARGV[0], TG_OP);
  RETURN NULL;
END $$;
`;

const TABLES = `
SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS key,
       format('%I.%I', n.nspname, c.relname) AS ident,
       (SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]') FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '') AS cols,
       (SELECT coalesce(json_agg(json_build_object('seq', s.seq, 'col', s.col)), '[]') FROM (
          SELECT pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq, a.attname AS col
            FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) s
         WHERE s.seq IS NOT NULL) AS seqs
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'oodle') AND n.nspname NOT LIKE 'pg\\_%'
 ORDER BY 1`;

/** Records writes on every table the schema created, and returns the tables and the rows the schema inserted. */
async function instrument(pg: PGlite): Promise<{ tables: Table[]; baseline: { table: Table; rows: string }[] }> {
  // uuid-ossp's uuid_generate_v4(), or an old pgcrypto's gen_random_uuid() outside pg_catalog, draw from their own randomness.
  const { rows: uuidFns } = await pg.query<{ fn: string }>(`SELECT format('%I.%I', n.nspname, p.proname) AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname IN ('uuid_generate_v4', 'gen_random_uuid') AND p.pronargs = 0 AND n.nspname NOT IN ('pg_catalog', 'oodle')`);
  if (uuidFns.length) await pg.exec(uuidFns.map((f) => `CREATE OR REPLACE FUNCTION ${f.fn}() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT oodle.next_uuid('4') $$;`).join('\n'));
  const { rows: tables } = await pg.query<Table>(TABLES);
  if (!tables.length) return { tables, baseline: [] };
  await pg.exec(tables.map((t) => `
    CREATE TRIGGER oodle_record AFTER INSERT OR UPDATE OR DELETE ON ${t.ident} FOR EACH ROW EXECUTE FUNCTION oodle.record_row(${lit(t.key)});
    CREATE TRIGGER oodle_record_truncate AFTER TRUNCATE ON ${t.ident} FOR EACH STATEMENT EXECUTE FUNCTION oodle.record_truncate(${lit(t.key)});`).join('\n'));
  const { rows } = await pg.query<{ key: string; rows: unknown[] }>(contentsQuery(tables));
  return { tables, baseline: rows.filter((r) => r.rows.length).map((r) => ({ table: tables.find((t) => t.key === r.key)!, rows: JSON.stringify(r.rows) })) };
}

const contentsQuery = (tables: Table[]) => tables.map((t) => `SELECT ${lit(t.key)} AS key, (SELECT coalesce(json_agg(r), '[]') FROM ${t.ident} r) AS rows`).join(' UNION ALL ');

// ── The wire protocol, as much of it as the bridge needs ───────────────────

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

function message(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 'latin1');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

function errorResponse(code: string, text: string): Buffer {
  const field = (f: string, v: string) => Buffer.concat([Buffer.from(f, 'latin1'), Buffer.from(v, 'utf8'), Buffer.from([0])]);
  return message('E', Buffer.concat([field('S', 'ERROR'), field('V', 'ERROR'), field('C', code), field('M', text), Buffer.from([0])]));
}

const readyForQuery = (status: 'I' | 'T') => message('Z', Buffer.from(status, 'latin1'));

/** Reads the NUL-terminated string at `at`, returning it and the offset after it. */
function cstring(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(0, at);
  return [buf.toString('utf8', at, end), end + 1];
}

/**
 * Every connection shares PGlite's one session, so named prepared statements and portals get a
 * per-connection prefix: two connections preparing "s1" don't collide.
 */
function renamed(msg: Buffer, prefix: string): Buffer {
  const type = String.fromCharCode(msg[0]);
  const name = (n: string) => (n ? `${prefix}${n}` : n);
  const rebuild = (parts: (string | Buffer)[]) =>
    message(type, Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.concat([Buffer.from(p, 'utf8'), Buffer.from([0])]) : p))));
  switch (type) {
    case 'P': { // Parse: statement name, query, parameter types
      const [stmt, at] = cstring(msg, 5);
      return stmt ? rebuild([name(stmt), msg.subarray(at)]) : msg;
    }
    case 'B': { // Bind: portal, statement, the rest
      const [portal, at] = cstring(msg, 5);
      const [stmt, rest] = cstring(msg, at);
      return portal || stmt ? rebuild([name(portal), name(stmt), msg.subarray(rest)]) : msg;
    }
    case 'D': // Describe and Close: 'S' or 'P', then a name
    case 'C': {
      const [n, at] = cstring(msg, 6);
      return n ? rebuild([msg.subarray(5, 6), name(n), msg.subarray(at)]) : msg;
    }
    case 'E': { // Execute: portal, row limit
      const [portal, at] = cstring(msg, 5);
      return portal ? rebuild([name(portal), msg.subarray(at)]) : msg;
    }
    default:
      return msg;
  }
}

/** The SQL text a message carries: a simple Query, or the query of a Parse. */
function sqlOf(msg: Buffer): string | null {
  const type = String.fromCharCode(msg[0]);
  if (type === 'Q') return cstring(msg, 5)[0];
  if (type === 'P') return cstring(msg, cstring(msg, 5)[1])[0];
  return null;
}

interface Conn {
  id: number;
  socket: net.Socket;
  buffer: Buffer;
  started: boolean;
  /** After a refused or timed-out message in the extended protocol, the backend skips to Sync. */
  skipping: boolean;
  queue: Promise<void>;
}

/**
 * The session lock. PGlite has one session, so one connection holds it from its first message
 * until its Sync or Query completes, and for as long as it has a transaction open.
 */
class Session {
  owner: Conn | 'oodle' | null = null;
  private waiters: { who: Conn | 'oodle'; wake: () => void }[] = [];

  acquire(who: Conn | 'oodle', timeoutMs: number): Promise<boolean> {
    if (this.owner === null || this.owner === who) {
      this.owner = who;
      return Promise.resolve(true);
    }
    return new Promise((done) => {
      const waiter = { who, wake: () => { clearTimeout(timer); done(true); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        done(false);
      }, timeoutMs);
      timer.unref();
      this.waiters.push(waiter);
    });
  }

  release(who: Conn | 'oodle') {
    if (this.owner !== who) return;
    const next = this.waiters.shift();
    this.owner = next?.who ?? null;
    next?.wake();
  }
}

// ── The simulated database ──────────────────────────────────────────────────

/**
 * One database per project for the life of the process. The app's modules are cached, and so are
 * its pool's connections: a second run of the same project in one process (tests, `oodle mutate`,
 * an embedder) must find the same bridge at the other end of them.
 */
const live = new Map<string, SimDatabase>();

interface Source {
  rel: string;
  sql: string;
}

export class SimDatabase {
  private pg!: PGlite;
  /** What the loaded schema was built from: a different schema needs a fresh Postgres. */
  private schemaKey = '';
  private tables: Table[] = [];
  /** Rows the migrations themselves inserted (lookup tables, plans, roles): restored before every run. */
  private baseline: { table: Table; rows: string }[] = [];
  private session = new Session();
  private server: net.Server | null = null;
  private conns = new Set<Conn>();
  private clients = new Set<net.Socket>();
  private injections: string[] = [];
  private nextConn = 1;
  private detachers: (() => void)[] = [];

  private constructor(private nowMs: number, readonly socketPath: string) {}

  /**
   * Boots Postgres and applies the schema (or reuses this project's database from an earlier run in
   * this process, if the schema is the same), then points the app at it until `close()`. Throws an
   * OodleError the CLI can show.
   */
  static async open(projectDir: string, config: NonNullable<Config['database']>, now: string): Promise<SimDatabase> {
    const find = resolver(projectDir);
    const entry = find(PGLITE);
    if (!entry) {
      throw new OodleError('database-driver', 'The simulated database needs PGlite, which is not installed', {
        hint: `Install it next to Oodle: npm i -D ${PGLITE} (or pnpm add -D, yarn add -D, bun add -d). It is Postgres compiled to WebAssembly, so nothing else is needed.`,
      });
    }
    const sources: Source[] = schemaFiles(projectDir, config.schema).map((f) => ({ rel: relative(projectDir, f), sql: upHalf(readFileSync(f, 'utf8')) }));
    const key = `${entry}\n${now}\n${stableStringify(sources)}`;
    const home = resolve(projectDir);
    let db = live.get(home);
    if (!db) {
      const socketPath = process.platform === 'win32'
        ? `\\\\.\\pipe\\oodle-db-${process.pid}-${Math.random().toString(36).slice(2)}`
        : join(tmpdir(), `oodle-db-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
      db = new SimDatabase(Date.parse(now), socketPath);
      await db.load(entry, find, sources, key);
      await db.serve();
      live.set(home, db);
    } else if (db.schemaKey !== key) {
      await db.load(entry, find, sources, key);
    }
    db.attach(config.env);
    return db;
  }

  /** Boots a fresh Postgres with the schema applied. On success it replaces the one in use, if any. */
  private async load(entry: string, find: (spec: string) => string | null, sources: Source[], key: string): Promise<void> {
    const extensions: Record<string, unknown> = {};
    for (const name of extensionsIn(sources.map((s) => s.sql).join('\n'))) {
      const path = find(`${PGLITE}/contrib/${name}`);
      if (!path) continue; // Not shipped with PGlite: applying the schema says so, with the file and line.
      const mod = await import(pathToFileURL(path).href);
      extensions[name] = mod[name] ?? mod.default?.[name];
    }
    const { PGlite } = await import(pathToFileURL(entry).href);
    const pg: PGlite = await PGlite.create({ extensions });
    try {
      await this.frozen(() => pg.exec(PRELUDE));
      for (const s of sources) await this.apply(pg, s.rel, s.sql);
      const { tables, baseline } = await instrument(pg);
      const previous = this.pg;
      Object.assign(this, { pg, tables, baseline, schemaKey: key });
      await previous?.close().catch(() => {});
    } catch (err) {
      await pg.close().catch(() => {});
      throw err;
    }
  }

  /** Runs `fn` with the simulation's clock, so now(), current_timestamp and defaults built on them are fixed. */
  private async frozen<T>(fn: () => Promise<T>): Promise<T> {
    const D = globalThis.Date;
    const real = D.now;
    D.now = () => this.nowMs;
    try {
      return await fn();
    } finally {
      D.now = real;
    }
  }

  /** Applies one schema file. A role it grants to and nobody created (anon, authenticated) is created and the file retried. */
  private async apply(pg: PGlite, rel: string, sql: string): Promise<void> {
    const created = new Set<string>();
    for (;;) {
      try {
        await this.frozen(() => pg.exec(sql));
        return;
      } catch (err) {
        const e = err as Error & { position?: string; code?: string };
        const role = /^role "([^"]+)" does not exist/.exec(e.message)?.[1];
        if (role && !created.has(role)) {
          created.add(role);
          await pg.exec(`CREATE ROLE ${qi(role)} NOLOGIN`);
          continue;
        }
        const line = lineOf(sql, e);
        const ext = /extension "([^"]+)" is not available|could not open extension control file ".*\/([^/]+)\.control"/.exec(e.message);
        throw new OodleError('database-schema', `Could not apply ${rel} to the simulated database`, {
          problems: [`${rel}${line ? `:${line}` : ''}: ${e.message}`],
          cause: err,
          hint: ext
            ? `PGlite doesn't ship the ${ext[1] ?? ext[2]} extension. Drop it from the schema Oodle applies, or point database.schema at files that don't need it.`
            : /schema "auth"|auth\.uid|auth\.users/.test(e.message)
              ? 'The schema refers to Supabase\'s auth schema, which isn\'t in your migrations. Add a .sql file that creates what it needs (e.g. auth.users) and list it first under database.schema.'
              : 'Oodle applies database.schema in name order, once, before the runs. Fix the SQL, or point database.schema at the files your migrations tool generates.',
        });
      }
    }
  }

  /** Serves the wire protocol on a Unix socket in this process. */
  private async serve(): Promise<void> {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((done, fail) => {
      this.server!.once('error', fail);
      this.server!.listen(this.socketPath, () => done());
    });
  }

  /** Points the env vars at the database and routes the app's connects to it, until `close()`. */
  private attach(env: string | string[] | undefined): void {
    this.server?.ref();
    for (const s of [...this.clients, ...[...this.conns].map((c) => c.socket)]) s.ref();
    const targets = new Set(LOCAL_HOSTS.map((h) => `${h}:${PORT}`));
    // OODLE_DATABASE_URL says a simulated database is up, and which URL is its: nextApp keeps it through Next's env reload.
    for (const name of new Set(['OODLE_DATABASE_URL', ...[env ?? 'DATABASE_URL'].flat()])) {
      const previous = process.env[name];
      // An app that reads a URL from .env.test before Oodle sets it still reaches the simulation.
      try {
        const url = previous && previous !== DATABASE_URL ? new URL(previous) : null;
        if (url && /^postgres(ql)?:$/.test(url.protocol)) targets.add(`${url.hostname.replace(/^\[|\]$/g, '')}:${url.port || PORT}`);
      } catch { /* not a URL */ }
      process.env[name] = DATABASE_URL;
      this.detachers.push(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
    }
    this.detachers.push(routeConnections((host, port, socket) => {
      if (!targets.has(`${host.replace(/^\[|\]$/g, '')}:${port ?? PORT}`)) return undefined;
      this.clients.add(socket);
      socket.once('close', () => this.clients.delete(socket));
      return this.socketPath;
    }));
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = { id: this.nextConn++, socket, buffer: Buffer.alloc(0), started: false, skipping: false, queue: Promise.resolve() };
    this.conns.add(conn);
    socket.setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk]);
      for (let msg = this.frame(conn); msg; msg = this.frame(conn)) {
        const m = msg;
        conn.queue = conn.queue.then(() => this.handle(conn, m)).catch((err) => this.fail(conn, err));
      }
    });
    const gone = () => {
      if (!this.conns.delete(conn)) return;
      conn.queue = conn.queue.then(() => this.hangUp(conn));
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  /** Cuts one whole message off the connection's buffer: untyped before startup, typed after. */
  private frame(conn: Conn): Buffer | null {
    const b = conn.buffer;
    const typed = conn.started ? 1 : 0;
    if (b.length < typed + 4) return null;
    const total = typed + b.readInt32BE(typed);
    if (b.length < total) return null;
    conn.buffer = b.subarray(total);
    if (!conn.started && b.readInt32BE(4) !== SSL_REQUEST && b.readInt32BE(4) !== GSSENC_REQUEST) conn.started = true;
    return b.subarray(0, total);
  }

  private write(conn: Conn, data: Uint8Array): void {
    if (data.length && conn.socket.writable) conn.socket.write(data);
  }

  private async handle(conn: Conn, msg: Buffer): Promise<void> {
    if (msg[0] < 0x20) {
      // Before startup: SSL and GSS encryption are declined ('N'), a cancel is ignored, and the startup message goes to PGlite.
      const code = msg.readInt32BE(4);
      if (code === SSL_REQUEST || code === GSSENC_REQUEST) return this.write(conn, Buffer.from('N'));
      if (code === CANCEL_REQUEST) return void conn.socket.end();
      return this.exec(conn, msg, true);
    }
    const type = String.fromCharCode(msg[0]);
    if (type === 'X') { // Terminate: the client is done. PGlite's session is shared, so it isn't told.
      conn.socket.end();
      return;
    }
    if (conn.skipping) {
      if (type !== 'S') return;
      conn.skipping = false;
      // Messages earlier in this cycle reached PGlite, so it needs the Sync that ends it. Otherwise the cycle is Oodle's to end.
      if (this.session.owner === conn) return this.exec(conn, msg, true);
      return this.write(conn, readyForQuery(this.pg.isInTransaction() ? 'T' : 'I'));
    }
    const sql = sqlOf(msg);
    if (sql !== null && sql.includes(INJECTION_SQL)) {
      this.injections.push(sql.replace(/\s+/g, ' ').trim().slice(0, 160));
      return this.refuse(conn, type, '42501', 'Oodle refused this statement: request input reached the SQL text instead of a parameter (oodle.sql-injection)');
    }
    return this.exec(conn, renamed(msg, `o${conn.id}_`), type === 'Q' || type === 'S');
  }

  private async exec(conn: Conn, msg: Buffer, endsCycle: boolean): Promise<void> {
    if (!(await this.session.acquire(conn, WAIT_MS))) {
      const type = String.fromCharCode(msg[0]);
      return this.refuse(conn, type, '55P03', `Oodle's simulated database runs one transaction at a time, and another connection held it for ${WAIT_MS / 1000}s. Commit or roll back before querying on a second connection.`);
    }
    try {
      this.write(conn, await this.frozen(() => this.pg.execProtocolRaw(msg)));
    } finally {
      if (endsCycle && !this.pg.isInTransaction()) this.session.release(conn);
    }
  }

  /**
   * Answers a message with an error instead of running it, as the backend would: a Query or a Sync
   * ends its cycle with ReadyForQuery, and any other message skips the rest of its cycle up to the Sync.
   */
  private refuse(conn: Conn, type: string, code: string, text: string): void {
    this.write(conn, errorResponse(code, text));
    if (type === 'Q' || type === 'S') {
      this.write(conn, readyForQuery(this.session.owner === conn && this.pg.isInTransaction() ? 'T' : 'I'));
      if (!this.pg.isInTransaction()) this.session.release(conn);
    } else {
      conn.skipping = true;
    }
  }

  private fail(conn: Conn, err: unknown): void {
    this.write(conn, errorResponse('XX000', `Oodle's simulated database: ${(err as Error).message}`));
    conn.socket.destroy();
  }

  /** A connection that hangs up mid-transaction gets it rolled back, as Postgres would. */
  private async hangUp(conn: Conn): Promise<void> {
    if (this.session.owner !== conn) return;
    if (this.pg.isInTransaction()) await this.pg.exec('ROLLBACK').catch(() => {});
    this.session.release(conn);
  }

  /** Runs Oodle's own statements between the app's: waits for the session, then takes it from a connection that never let go. */
  private async own<T>(fn: () => Promise<T>): Promise<T> {
    if (!(await this.session.acquire('oodle', 1000))) this.session.owner = 'oodle';
    try {
      if (this.pg.isInTransaction()) await this.pg.exec('ROLLBACK');
      return await this.frozen(fn);
    } finally {
      this.session.release('oodle');
    }
  }

  /** Table names, for messages. */
  get tableNames(): string[] {
    return this.tables.map((t) => t.key);
  }

  /**
   * Puts the database back where every run starts: the schema's own rows, then `seed`, with sequences
   * past the seeded ids, uuids and random() from the top, and the change log empty. Rows go in with
   * triggers and foreign keys off, so tables can be seeded in any order. Throws a plain Error naming
   * the problem when the seed doesn't fit the schema.
   */
  async reset(seed: Record<string, unknown> | undefined): Promise<void> {
    const byKey = new Map(this.tables.map((t) => [t.key, t]));
    // uuids and random() start over first, so seeded rows that take a default get the same ones every run.
    const sql = ['ALTER SEQUENCE oodle.uuid_seq RESTART', 'SELECT setseed(0)', 'SET session_replication_role = replica'];
    if (this.tables.length) sql.push(`TRUNCATE ${this.tables.map((t) => t.ident).join(', ')} RESTART IDENTITY CASCADE`);
    const cols = (names: string[]) => names.map(qi).join(', ');
    // A table the seed names starts with exactly those rows: given.db replaces, like every list in given.
    for (const { table, rows } of this.baseline.filter((b) => !(b.table.key in (seed ?? {})))) {
      sql.push(`INSERT INTO ${table.ident} (${cols(table.cols)}) OVERRIDING SYSTEM VALUE SELECT ${cols(table.cols)} FROM json_populate_recordset(null::${table.ident}, ${lit(rows)})`);
    }
    for (const [key, rows] of Object.entries(seed ?? {})) {
      const table = byKey.get(key);
      if (!table) {
        const near = suggest(key, this.tableNames);
        throw new Error(`given.db.${key}: no such table${near ? `; did you mean ${near}?` : ''} Tables: ${this.tableNames.join(', ') || 'none (is database.schema set?)'}`);
      }
      if (!Array.isArray(rows)) throw new Error(`given.db.${key}: expected a list of rows, e.g. [{ id: 1 }]`);
      for (const [i, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`given.db.${key}[${i}]: expected a row, e.g. { id: 1 }`);
        const keys = Object.keys(row);
        const unknown = keys.find((k) => !table.cols.includes(k));
        if (unknown) {
          const near = suggest(unknown, table.cols);
          throw new Error(`given.db.${key}[${i}].${unknown}: ${key} has no such column${near ? `; did you mean ${near}?` : ''} Columns: ${table.cols.join(', ')}`);
        }
        if (!keys.length) {
          sql.push(`INSERT INTO ${table.ident} DEFAULT VALUES`);
          continue;
        }
        sql.push(`INSERT INTO ${table.ident} (${cols(keys)}) OVERRIDING SYSTEM VALUE SELECT ${cols(keys)} FROM json_populate_record(null::${table.ident}, ${lit(JSON.stringify(row))})`);
      }
    }
    for (const t of this.tables) {
      for (const { seq, col } of t.seqs) sql.push(`SELECT setval(${lit(seq)}::regclass, m) FROM (SELECT max(${qi(col)})::bigint AS m FROM ${t.ident}) s WHERE m IS NOT NULL`);
    }
    sql.push('SET session_replication_role = origin', 'TRUNCATE oodle.changes RESTART IDENTITY');
    this.injections = [];
    await this.own(async () => {
      try {
        await this.pg.exec(sql.join(';\n'));
      } catch (err) {
        await this.pg.exec('SET session_replication_role = origin').catch(() => {});
        throw new Error(`given.db: ${(err as Error).message}`);
      }
    });
  }

  /** What the app wrote since the last reset, in order, as effects on the data boundary. A rolled-back write never happened. */
  async changes(): Promise<EffectRecord[]> {
    const { rows } = await this.own(() => this.pg.query<{ tbl: string; op: string; old: Record<string, unknown> | null; new: Record<string, unknown> | null }>('SELECT tbl, op, old, new FROM oodle.changes ORDER BY seq'));
    return rows.map((r): EffectRecord => {
      const kind = `db.${r.tbl}.${{ INSERT: 'inserted', UPDATE: 'updated', DELETE: 'deleted', TRUNCATE: 'truncated' }[r.op] ?? r.op.toLowerCase()}`;
      if (r.op === 'INSERT') return { kind, boundary: 'data', payload: r.new };
      if (r.op === 'DELETE') return { kind, boundary: 'data', payload: r.old };
      if (r.op === 'UPDATE') {
        // The row as it is now, and in `result` the values the update replaced.
        const before = Object.fromEntries(Object.entries(r.old ?? {}).filter(([k, v]) => stableStringify(v) !== stableStringify(r.new?.[k])));
        return { kind, boundary: 'data', payload: r.new, result: before };
      }
      return { kind, boundary: 'data', payload: {} };
    });
  }

  /** Every table's rows as they are now, for constraints. */
  async contents(): Promise<Record<string, Record<string, unknown>[]>> {
    if (!this.tables.length) return {};
    const { rows } = await this.own(() => this.pg.query<{ key: string; rows: Record<string, unknown>[] }>(contentsQuery(this.tables)));
    return Object.fromEntries(rows.map((r) => [r.key, r.rows]));
  }

  /** Statements refused since the last reset because request input reached their text. */
  takeInjections(): string[] {
    const out = this.injections;
    this.injections = [];
    return out;
  }

  /**
   * Gives the environment back: env vars restored, connects no longer routed. The database stays up,
   * unreferenced so it doesn't keep the process alive, for the connections the app's pool still holds
   * and the next run of this project in this process.
   */
  async close(): Promise<void> {
    for (const undo of this.detachers.splice(0).reverse()) undo();
    this.server?.unref();
    for (const s of [...this.clients, ...[...this.conns].map((c) => c.socket)]) s.unref();
  }
}

export const sqlInjectionViolations = (statements: string[]) =>
  [...new Set(statements)].map((s) => `constraint ${SQL_INJECTION_ID} violated: request input reached the text of a SQL statement instead of a parameter: ${s}`);
