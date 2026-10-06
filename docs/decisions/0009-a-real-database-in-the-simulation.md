# 0009. The simulation includes a real Postgres, and what the app writes to it is behavior

- **Status:** Proposed
- **Date:** 2026-10-06
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0001. Outcomes and behaviors](0001-outcomes-and-behaviors.md), [0002. Constraints hold on every run](0002-constraints-hold-on-every-run.md), [0005. The simulation is sealed](0005-sealed-simulation.md)

## Context

Most services Oodle is pointed at keep their state in Postgres, through `pg`, `postgres.js` or something built on them (Drizzle, Kysely, Knex, Prisma's pg adapter). The simulation had no place for them:

- The seal (0005) refuses the driver's socket, so every query fails and every outcome that touches data is broken before it starts. The only ways out were `sealed: { allow: [localhost:5432] }`, which makes runs depend on a server someone has to start and reset, or rewriting the data layer as a module-level store seeded in `setup(ctx)`, which is the opposite of "your code doesn't change".
- What an app does to its data was invisible. A route that answers correctly but forgets to write the refund, or writes it twice, passed. The `data` boundary existed in the catalog with nothing to observe on it.
- The security pack's injection condition sent attack strings, but nothing could tell whether one reached SQL.

## Decision

1. **`database:` in `oodlc/config.yaml` gives the app a real Postgres, in process.** Oodle boots PGlite (Postgres compiled to WebAssembly), applies `database.schema` (a `.sql` file or a folder of migrations, in name order, down migrations skipped) once, and sets `DATABASE_URL` (or the variables `database.env` names). The seal routes the driver's TCP connect to a Unix socket served by Oodle's own process. No port opens, nothing leaves the machine, nothing needs starting. PGlite is an optional peer dependency the project installs.
2. **Every run starts from the same database:** the schema, the rows the migrations themselves inserted, and the rows `given.db` names. `given.db` layers like the rest of `given` (defaults, then the trigger, then the condition), and naming a table replaces its rows. Rows go in with foreign keys and triggers off, so order doesn't matter, and sequences move past seeded ids. An unknown table or column fails the run, with a suggestion.
3. **Time, uuids, `random()` and serial ids are deterministic,** like everything else in a run: `now()` reads the simulation's clock, `gen_random_uuid()` and friends count, `random()` is seeded, identities restart. Two runs of the same code give the same rows.
4. **Each row the app writes is an effect on the `data` boundary,** in the order it happened: `db.<table>.inserted`, `.updated` (the new row, and in `result` the values it replaced), `.deleted`, `.truncated`. A rolled-back write never happened, so it isn't recorded.
   - Like internal effects, they are **behavior**: a change to what gets written is reported under the outcome, never blocking by itself. A storage refactor (a new column, a renamed internal field) is the system's own business.
   - An outcome that **expects** one (`effects: [{ kind: db.orders.updated, match: { status: refunded }, count: 1 }]`) makes it a promise, which blocks like any expectation.
   - They are **not internal**: a constraint written as `effects.every(e => e.boundary === 'internal')` ("this request changes nothing") fails when the app writes a row.
5. **Constraints see the tables after the run as `db`,** next to `effects`, `state`, `response` and `request`, on every run including probes of unknown routes (0002).
6. **`oodle.sql-injection` is a built-in constraint, like `oodle.sealed`.** A statement whose SQL text contains the security pack's injection payload, unescaped, means request input became SQL instead of a parameter. The statement is refused (so the payload's `DROP TABLE` never runs) and the run records a violation, which blocks.

## Options considered

### A. Leave databases to `sealed.allow` and a Postgres the user runs

- Good: nothing new in Oodle.
- Bad: runs depend on a server's state, so the outcome diff stops being reproducible. CI needs a service container. Nothing resets between runs, and nothing records what was written.

### B. Spin up a real Postgres per run (Docker, testcontainers, embedded binaries)

- Good: exactly production's engine.
- Bad: seconds per start, Docker in CI and on every laptop, platform-specific binaries, and it still needs a reset and a write log. Oodle runs dozens of runs per check.

### C. Stub the database as effects, like an HTTP API

- Good: fits the existing model with no new machinery.
- Bad: a database isn't a request/response API. Stubbing every query is more work than the code it tests, and it tests nothing about the SQL.

### D. PGlite in process, wire protocol over a Unix socket (chosen)

- Good: the app's own driver and SQL run against real Postgres, unchanged. About half a second to boot once per process, then about a millisecond to reset per run. Works the same on a laptop and in CI, with nothing to install but an npm package.
- Good: it is inside the process, so Oodle can make it deterministic, log every write with triggers, and read every statement's text.
- Bad: one session for every connection. Oodle serializes connections, keeps per-connection prepared statement names apart, and holds the session for a connection while its transaction is open. Two transactions at once can't overlap: a connection that waits more than 5 seconds for another's transaction gets an error that says so.
- Bad: PGlite is Postgres without some extensions and without other processes. Schemas that need an extension it doesn't ship fail with a message naming it.

## Consequences

- Services on Postgres run in Oodle without a data-layer rewrite, and `oodle init` sets `database:` up when it finds a Postgres driver and a schema.
- The `data` boundary has observable evidence. Outcomes can promise what gets stored, and constraints can hold over the data itself, not just the effects around it.
- The security pack's injection condition now finds SQL injection, not just odd responses.
- Clients that talk HTTP to a hosted Postgres proxy (`@neondatabase/serverless`, `@vercel/postgres`, supabase-js) aren't served: their calls are HTTP effects, as before. Prisma needs a driver adapter such as `@prisma/adapter-pg`, the default since Prisma 7; its older native engine opens sockets Oodle can't see.

## Revisit if

- Apps commonly hold one transaction open while querying on another connection. Then run the waiting statement inside the open transaction, or give each connection its own PGlite with a shared data directory.
- People ask for MySQL or SQLite. The shape (schema once, reset per run, writes as `data` effects, `db` in constraints) carries over; the engine and the wire protocol don't.
- Checking `expect.db` against a table's final rows proves more useful than expecting writes as effects.
