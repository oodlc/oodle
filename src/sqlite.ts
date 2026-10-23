/**
 * The simulated SQLite database. With `database: { engine: sqlite }` in oodlc/config.yaml, Oodle runs
 * SQLite in its own process (node:sqlite, built into Node 22.13 and later) with the schema or
 * migrations applied, and hands it to the app as a Cloudflare D1 binding (src/workers.ts).
 *
 * It keeps the promises the Postgres simulation keeps (src/database.ts, docs/decisions/0009): every run
 * starts from the schema's own rows plus `given.db`; every row the app writes is recorded, in order,
 * as an effect on the data boundary (`db.cards.inserted`, `.updated`, `.deleted`); constraints see
 * every table after the run as `db`; and a statement whose text carries the security pack's
 * injection payload is refused and recorded as a violation of `oodle.sql-injection`. See docs/decisions/0017.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { DatabaseConfig, EffectRecord } from './types.ts';
import { OodleError, suggest } from './errors.ts';
import { stableStringify } from './expect.ts';
import { INJECTION_SQL } from './security.ts';
import { schemaFiles } from './database.ts';

/** The part of node:sqlite Oodle uses. Loaded on open, so Node versions without it still run everything else. */
interface Sync {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } };
  close(): void;
}

/** Where the open database is published for an adapter loaded from dist/, which can't share this module's instance. */
export const SQLITE_KEY = Symbol.for('oodle.sqlite');

const INTERNAL = /^(sqlite_|oodle_|_cf_|d1_migrations$)/;
const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A value as SQLite stores it, the way D1 converts what a Worker binds. */
function toSql(v: unknown): unknown {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a supported value; use null');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) return JSON.stringify(v);
  return v;
}

export class SqliteDatabase {
  private tables: { name: string; cols: string[] }[] = [];
  private baseline = new Map<string, Record<string, unknown>[]>();
  private injections: string[] = [];

  private constructor(private db: Sync) {}

  static async open(projectDir: string, config: DatabaseConfig): Promise<SqliteDatabase> {
    let DatabaseSync: new (path: string) => Sync;
    try {
      ({ DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: typeof DatabaseSync });
    } catch {
      throw new OodleError('database-driver', `The simulated SQLite database needs node:sqlite, which Node ${process.versions.node} doesn't have`, {
        hint: 'Run Oodle on Node 22.13 or later (24 is the current LTS). Nothing to install: SQLite is built in.',
      });
    }
    const sim = new SqliteDatabase(new DatabaseSync(':memory:'));
    for (const file of schemaFiles(projectDir, config.schema)) {
      try {
        sim.db.exec(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new OodleError('database-schema', `${relative(projectDir, file)} doesn't apply to SQLite`, { problems: [(err as Error).message], hint: 'Fix the migration, or point database.schema at the ones D1 applies.' });
      }
    }
    sim.track();
    for (const t of sim.tables) sim.baseline.set(t.name, sim.db.prepare(`SELECT * FROM ${qi(t.name)}`).all().map((r) => ({ ...r })));
    sim.db.exec('PRAGMA foreign_keys = ON');
    (globalThis as Record<symbol, unknown>)[SQLITE_KEY] = sim;
    return sim;
  }

  /** A trigger per table and write, so every row the app writes lands in oodle_changes as JSON. */
  private track() {
    this.db.exec('CREATE TABLE oodle_changes (seq INTEGER PRIMARY KEY, tbl TEXT, op TEXT, old TEXT, new TEXT)');
    const names = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name)).filter((n) => !INTERNAL.test(n));
    for (const name of names) {
      const cols = this.db.prepare(`SELECT name FROM pragma_table_info(${`'${name.replace(/'/g, "''")}'`})`).all().map((r) => String(r.name));
      this.tables.push({ name, cols });
      const row = (side: 'NEW' | 'OLD') => `json_object(${cols.map((c) => `'${c.replace(/'/g, "''")}', CASE typeof(${side}.${qi(c)}) WHEN 'blob' THEN hex(${side}.${qi(c)}) ELSE ${side}.${qi(c)} END`).join(', ')})`;
      for (const [op, old, nu] of [['INSERT', 'NULL', row('NEW')], ['UPDATE', row('OLD'), row('NEW')], ['DELETE', row('OLD'), 'NULL']]) {
        this.db.exec(`CREATE TRIGGER ${qi(`oodle_${name}_${op.toLowerCase()}`)} AFTER ${op} ON ${qi(name)} BEGIN INSERT INTO oodle_changes (tbl, op, old, new) VALUES ('${name.replace(/'/g, "''")}', '${op}', ${old}, ${nu}); END`);
      }
    }
  }

  get tableNames(): string[] {
    return this.tables.map((t) => t.name);
  }

  /** Every table back to the schema's own rows, then `seed`, which replaces a table's rows when it names it. Throws a plain Error naming what doesn't fit. */
  async reset(seed: Record<string, unknown> | undefined): Promise<void> {
    const byName = new Map(this.tables.map((t) => [t.name, t]));
    for (const [key, rows] of Object.entries(seed ?? {})) {
      const table = byName.get(key);
      if (!table) {
        const near = suggest(key, this.tableNames);
        throw new Error(`given.db.${key}: no such table${near ? `; did you mean ${near}?` : ''} Tables: ${this.tableNames.join(', ') || 'none (is database.schema set?)'}`);
      }
      if (!Array.isArray(rows)) throw new Error(`given.db.${key}: expected a list of rows, e.g. [{ id: 1 }]`);
      for (const [i, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`given.db.${key}[${i}]: expected a row, e.g. { id: 1 }`);
        const unknown = Object.keys(row).find((k) => !table.cols.includes(k));
        if (unknown) {
          const near = suggest(unknown, table.cols);
          throw new Error(`given.db.${key}[${i}].${unknown}: ${key} has no such column${near ? `; did you mean ${near}?` : ''} Columns: ${table.cols.join(', ')}`);
        }
      }
    }
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (const t of this.tables) this.db.exec(`DELETE FROM ${qi(t.name)}`);
      if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").all().length) this.db.exec('DELETE FROM sqlite_sequence');
      for (const t of this.tables) {
        const rows = (seed && t.name in seed ? seed[t.name] : this.baseline.get(t.name)) as Record<string, unknown>[];
        for (const row of rows ?? []) {
          const keys = Object.keys(row);
          if (!keys.length) this.db.exec(`INSERT INTO ${qi(t.name)} DEFAULT VALUES`);
          else this.db.prepare(`INSERT INTO ${qi(t.name)} (${keys.map(qi).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => toSql(row[k])));
        }
      }
    } catch (err) {
      throw new Error(`given.db: ${(err as Error).message}`);
    } finally {
      this.db.exec('DELETE FROM oodle_changes');
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    this.injections = [];
  }

  async changes(): Promise<EffectRecord[]> {
    return this.db.prepare('SELECT tbl, op, old, new FROM oodle_changes ORDER BY seq').all().map((r): EffectRecord => {
      const kind = `db.${r.tbl}.${{ INSERT: 'inserted', UPDATE: 'updated', DELETE: 'deleted' }[String(r.op)]}`;
      const old = r.old ? JSON.parse(String(r.old)) : null;
      const nu = r.new ? JSON.parse(String(r.new)) : null;
      if (r.op === 'INSERT') return { kind, boundary: 'data', payload: nu };
      if (r.op === 'DELETE') return { kind, boundary: 'data', payload: old };
      const before = Object.fromEntries(Object.entries(old ?? {}).filter(([k, v]) => stableStringify(v) !== stableStringify(nu?.[k])));
      return { kind, boundary: 'data', payload: nu, result: before };
    });
  }

  async contents(): Promise<Record<string, Record<string, unknown>[]>> {
    return Object.fromEntries(this.tables.map((t) => [t.name, this.db.prepare(`SELECT * FROM ${qi(t.name)}`).all().map((r) => ({ ...r }))]));
  }

  takeInjections(): string[] {
    const out = this.injections;
    this.injections = [];
    return out;
  }

  async close(): Promise<void> {
    const g = globalThis as Record<symbol, unknown>;
    if (g[SQLITE_KEY] === this) delete g[SQLITE_KEY];
    this.db.close();
  }

  /** Request input pasted into SQL text: refused before it runs, and remembered as a violation. */
  private guard(sql: string): void {
    if (!sql.includes(INJECTION_SQL)) return;
    this.injections.push(sql);
    throw new Error('D1_ERROR: refused by Oodle: request input reached the text of this statement (oodle.sql-injection)');
  }

  /** The Cloudflare D1 binding over this database: prepare, bind, first, all, run, raw, batch and exec. */
  d1(): D1Database {
    return new D1Database(this.db, (sql) => this.guard(sql));
  }
}

type Row = Record<string, unknown>;
const meta = (changes: number, lastRowId: number) => ({ duration: 0, changes, last_row_id: lastRowId, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes });

export class D1PreparedStatement {
  constructor(private db: Sync, private guard: (sql: string) => void, readonly sql: string, private params: unknown[] = []) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1PreparedStatement(this.db, this.guard, this.sql, values.map(toSql));
  }

  /** Runs the statement now. Rows come back as plain objects, and changes as D1 counts them. */
  execute(): { results: Row[]; meta: ReturnType<typeof meta> } {
    this.guard(this.sql);
    const results = this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
    const [{ c, id }] = this.db.prepare('SELECT changes() AS c, last_insert_rowid() AS id').all() as { c: number; id: number }[];
    const wrote = /^\s*(insert|update|delete|replace)\b/i.test(this.sql);
    return { results, meta: meta(wrote ? Number(c) : 0, Number(id)) };
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const [row] = this.execute().results;
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> {
    const { results, meta: m } = this.execute();
    return { results: results as T[], success: true, meta: m };
  }

  async run<T = Row>(): Promise<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { results } = this.execute();
    const rows = results.map((r) => Object.values(r));
    return (options?.columnNames ? [Object.keys(results[0] ?? {}), ...rows] : rows) as T[];
  }
}

export class D1Database {
  constructor(private db: Sync, private guard: (sql: string) => void) {}

  prepare(sql: string): D1PreparedStatement {
    return new D1PreparedStatement(this.db, this.guard, sql);
  }

  /** Every statement in one transaction: all of them, or none if one fails. */
  async batch<T = Row>(statements: D1PreparedStatement[]) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => {
        const { results, meta: m } = s.execute();
        return { results: results as T[], success: true as const, meta: m };
      });
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.guard(sql);
    this.db.exec(sql);
    return { count: sql.split(';').filter((s) => s.trim()).length, duration: 0 };
  }

  withSession(): D1Database {
    return this;
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('D1 dump() is not simulated by Oodle');
  }
}
