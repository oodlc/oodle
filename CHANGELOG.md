# Changelog

Oodle is v0. Until 1.0, a minor version (0.x.0) can change the catalog format or the CLI; this file says when one does, under **Changes**. A patch version (0.x.y) only fixes things.

The GitHub Action follows the newest release through the `v0` tag (`uses: oodlc/oodle@v0`).

## 0.8.0 (2026-10-06): schemas at oodlc.com, docs for agents

- The catalog and config schemas are published at `https://oodlc.com/schema/v0/catalog.json` and `https://oodlc.com/schema/v0/config.json`, and their `$id`s say so.
- Every YAML file `oodle init` and `oodle propose` write starts with a `# yaml-language-server: $schema=…` line, so editors with the YAML language server complete and check the catalog as you type.
- Fix: an approval from an org member whose membership is private counts. GitHub labels them `CONTRIBUTOR` to the workflow's token, so the Action now looks up the approver's permission on the repository (`write`, `maintain` or `admin`).
- The docs are readable on [oodlc.com/docs](https://oodlc.com/docs), and as markdown for agents at [oodlc.com/llms.txt](https://oodlc.com/llms.txt).

## 0.7.0 (2026-10-06): a real database in the simulation

- `database:` in `oodlc/config.yaml` runs Postgres in process ([PGlite](https://pglite.dev)) and points `DATABASE_URL` at it. Your own driver connects as in production: no Docker, no port.
- Every run starts from the schema plus `given.db`. Each row the app writes is an effect on the new `data` boundary (`db.<table>.inserted`, `updated`, `deleted`), and constraints see the tables as `db`.
- SQL built from request input is refused before it runs and blocks as `oodle.sql-injection`.
- `init` and `doctor` find the driver, the migrations and the env var. See [0009](docs/decisions/0009-a-real-database-in-the-simulation.md).

## 0.6.0 (2026-10-06): a first outcome in five minutes

- `init` follows `app.listen()`, `createServer(app)` or `serve({ fetch: app.fetch })` back to the module that builds the app.
- `init` names the outbound hosts it finds (URLs in the source, SDKs like Stripe in `package.json`) under `effects` and gives each a placeholder stub.
- `init` probes each route nothing describes and saves a proposed outcome to `oodlc/proposed.yaml`. `oodle propose --routes` does the same later.
- `init --ci` in an existing project writes only the workflow.
- A failing run names a missing stub first, and an effect whose call failed says so instead of "got 0". `doctor` checks that every effect the app names has a stub.
- Proxy environment variables can't carry a call past the effect rules.
- New guide: [Your first outcome in 5 minutes](docs/first-outcome.md).

## 0.5.0 (2026-10-06): Next.js apps

- `@oodlc/oodle/next` exports `nextApp()`, which runs `app/**/route.ts` and the middleware in process, inside Next's own route module, with no build and no server. Next 15 and 16. See [0008](docs/decisions/0008-nextjs-through-its-own-route-module.md).
- `init` detects Next.js and writes `oodle.app.ts` around `nextApp`. `mutate` starts from every route file and the middleware.

## 0.4.4 (2026-10-06)

- Hints and help name the command that works where you are (`pnpm exec oodle run`, `npx oodle run`), not a bare `oodle` that isn't on the PATH.

## 0.4.3 (2026-10-06)

- `init --ci` reads the lockfile and writes the matching install step for npm, pnpm, yarn or bun.

## 0.4.2 (2026-10-06)

- Calls through `node:http` and `node:https` agents become effects, not just `fetch`: axios, got, node-fetch and SDKs on their default clients (Stripe, Twilio, AWS) are stubbed and recorded.
- Releases publish to npm from CI with provenance.

## 0.4.1 (2026-10-05)

- Published to npm as `@oodlc/oodle`. Imports are `@oodlc/oodle/adapter` and `@oodlc/oodle/contract`. The command is still `oodle`.

## 0.4.0 (2026-10-05): adoptable in CI for existing services

- **Changes:** approvals. A change to a promise gets an `id@fingerprint`, and a maintainer other than the author approves it with `/oodle approve` in a review. See [0007](docs/decisions/0007-approvals-in-ci.md).
- `@oodlc/oodle/adapter`: `httpApp()` runs an existing Express, Koa, Hono, `http.Server` or `(req, res)` app in process.
- `init` wraps the service already in the repo; `--ci` writes the workflow.
- `doctor` fails when Oodle runs the starter instead of your service, or the app reaches the network.
- The pull request that adds Oodle reports every outcome as new instead of failing.

## 0.3.0 (2026-10-05): Oodle for coding agents

- **Changes:** conditions carry their own expectations with `when` ([0004](docs/decisions/0004-conditions-carry-expectations.md)), and `status: proposed` on intents, outcomes and constraints runs and reports but never blocks ([0006](docs/decisions/0006-proposals-and-propose-only-agents.md)).
- The built-in `security.*` conditions, and probes of every route no outcome describes.
- The sealed simulation: a call to a host nobody named blocks as `oodle.sealed` ([0005](docs/decisions/0005-sealed-simulation.md)).
- `oodle mutate`, `oodle propose`, `oodle draft`, `oodle mcp`, and the Claude Code plugin.

## 0.2.0 (2026-10-05): one visible `oodlc/` folder

- **Changes:** a project is the directory that holds `oodlc/`. `oodlc/config.yaml` says how to run the app and every other YAML file in it is catalog. `oodle init --migrate` moves a 0.1 project in with `git mv`. See [0003](docs/decisions/0003-one-visible-oodlc-folder.md).

## 0.1.0 (2026-10-05)

- The OODLC v0 catalog, `oodle run`, `check`, `diff` and `lint`, readable effect diffs, and the GitHub Action.
