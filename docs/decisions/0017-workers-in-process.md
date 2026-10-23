# 0017. Cloudflare Workers run in process, with D1 as SQLite

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0005. Sealed simulation](0005-sealed-simulation.md), [0009. A real database in the simulation](0009-a-real-database-in-the-simulation.md)

## Context

Agents build a lot of apps on Cloudflare Workers. A review of Oodle on one (a Worker with D1, KV, `send_email`, static assets and HTMLRewriter) found Oodle couldn't run it. Up to 0.16.0, `init` wrote a placeholder that every check passed; 0.16.1 refuses instead. The reviewer wired the Worker up by hand in about 250 lines: Node loaders for `.yaml`, `.ttf` and `.wasm` imports and `cloudflare:workers`, D1 on an in-memory SQLite with the migrations applied, emails recorded instead of sent, and stand-ins for HTMLRewriter and `crypto.subtle.timingSafeEqual`. Their HTMLRewriter passed pages through untouched, so the pages Oodle saw were missing what the real Worker adds to them.

A Worker's `export default { fetch(request, env, ctx) }` is already the shape the adapter drives for Hono and Next.js. What's missing is everything around it: `env`, the `cloudflare:` modules, the non-JavaScript modules Wrangler bundles, and the globals Workers have and Node doesn't.

## Decision

1. **`@oodlc/oodle/workers` runs the Worker in Oodle's own process**, through `httpApp`, so the seal, effects, determinism, the security pack and `mutate` work as they do for every other app. `workerApp(() => import('./src/index.ts'), { wrangler })` registers module hooks first, then imports the Worker.
2. **`env` is built from the Wrangler config** (JSONC, JSON or TOML), binding by binding:
   - D1 is the simulated database, with `database: { engine: sqlite }`.
   - KV is a namespace kept in `ctx.state[<binding>]`.
   - Static assets are served from the assets directory before the Worker runs.
   - `vars`, plus `env` in the adapter, hold test values for secrets.
   - **Every other binding records each method call as the effect `<BINDING>.<method>`.** Sends (`send`, `sendBatch`, `put`, `delete`, `writeDataPoint`, `enqueue`) are emitted. Anything that answers is a stubbed call.
3. **SQLite joins Postgres as a simulated database**, on `node:sqlite` (Node 22.13+). It keeps 0009's promises: a reset per run to the migrations plus `given.db`, triggers that record every write as a `db.<table>.*` effect, `db` in constraints, and `oodle.sql-injection`. D1's API (`prepare`, `bind`, `first`, `all`, `run`, `raw`, `batch`, `exec`) runs on it.
4. **`cloudflare:workers`, `cloudflare:email`, `cloudflare:sockets` and `cloudflare:workflows`** are modules the simulation provides, for `import` and for `require`. A project without `"type": "module"` loads its TypeScript through `require`.
5. **HTMLRewriter is lol-html**, the engine Workers run, compiled to WebAssembly (`html-rewriter-wasm`, an optional peer dependency like PGlite). Without it, `transform()` throws and says what to install. It never passes a page through untouched.
6. **`ctx.waitUntil` work finishes before the run is judged.**
7. **`oodle init` detects a Worker** from a Wrangler config that names `main`. It writes `oodle.app.mts` (ESM whatever the package type, for the top-level `await`) with the paths the code compares against as routes, and the D1 migrations as the database.

## Options considered

### A. Miniflare or `wrangler dev`, out of process

- Good: the real runtime, every binding exact, Durable Objects included.
- Bad: requests leave Oodle's process, so its seal, effect recording and frozen time don't reach the Worker. Effects would have to be rebuilt from Miniflare's outbound hooks, binding by binding.
- Bad: a workerd process per run, and per mutant under `oodle mutate`, is seconds instead of milliseconds.
- Bad: D1 writes and table contents would come from a database Oodle doesn't own, so `given.db`, `db` in constraints and `oodle.sql-injection` would need a second implementation.

### B. In process, with the bindings simulated (chosen)

- Good: one simulation for every kind of app. A Worker's outcomes, constraints, security pack and mutation testing behave as an Express app's do, and run in milliseconds (the example's 30 mutants take about three seconds).
- Good: the parts that decide what a caller sees are real: D1 is SQLite, HTMLRewriter is lol-html.
- Bad: Node isn't workerd. A Worker that relies on a runtime difference (a Node API Cloudflare lacks, a request limit) can pass here and fail there. Outcomes test behavior, not the platform.
- Bad: bindings are added one at a time. Durable Object storage, scheduled and queue handlers, and Wrangler environments aren't simulated yet.

### C. Leave it to each project's own shim

- Good: nothing for Oodle to maintain.
- Bad: every project writes the same 250 lines, and each shim's gaps (a pass-through HTMLRewriter) hide bugs from the outcomes.

## Consequences

- A Worker gets the same `init`, `doctor`, `run`, `check` and `mutate` as an Express app. `examples/worker-cards` shows each binding and the outcomes from the review: one welcome email, no email for bots or cross-site posts, the admin redirect, the MCP token, and no unpublished card on a page.
- SQLite is a second database engine, open to any app through `database: { engine: sqlite }`, not only to Workers.
- On Node 20 the D1 simulation says it needs Node 22.13. Everything else runs.

## Revisit if

- A difference between Node and workerd changes an outcome's result in practice.
- Durable Objects, scheduled handlers or queue consumers are needed. Those need triggers other than HTTP, a decision of their own.
