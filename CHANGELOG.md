# Changelog

Oodle is v0. Until 1.0, a minor version (0.x.0) can change the catalog format or the CLI; this file says when one does, under **Changes**. A patch version (0.x.y) only fixes things.

The GitHub Action follows the newest release through the `v0` tag (`uses: oodlc/oodle@v0`).

## 0.18.0 (2026-10-23): Cloudflare Workers, in process

- **Changes:** `@oodlc/oodle/workers` runs a Cloudflare Worker's own fetch handler in process, in the sealed simulation, with `env` built from `wrangler.jsonc`, `.json` or `.toml`. D1 is SQLite with the migrations applied. KV lives in `given.state`. Static assets are served before the Worker. Every other binding (`send_email`, queues, services, R2, …) records each call as the effect `<BINDING>.<method>`. `ctx.waitUntil` work counts. `cloudflare:workers`, `cloudflare:email`, HTMLRewriter (lol-html, through the optional peer `html-rewriter-wasm`), `caches`, `crypto.subtle.timingSafeEqual`, and Text, Data and Wasm modules all work. See [0017](docs/decisions/0017-workers-in-process.md) and `examples/worker-cards`.
- **Changes:** `database` takes `engine: sqlite`: a real SQLite in process (`node:sqlite`, Node 22.13 or later), with the same reset, `given.db`, recorded writes, `db` in constraints and `oodle.sql-injection` as Postgres.
- `oodle init` wraps a Worker from a Wrangler config that names `main`. It writes `oodle.app.mts` with the paths the code compares against as routes, and the D1 migrations as the database. A Wrangler config with no `main` is still `unsupported-stack`.
- `oodle doctor` checks the SQLite database as it does Postgres.
- `oodle mutate` never mutates `@oodlc/oodle/workers` adapters.

## 0.17.0 (2026-10-23): headers, text and the host

- **Changes:** `expect` takes `headers` (response headers by name, any case, each a value or a matcher) and `text` (the whole body as text, for HTML pages). Matchers gain `not_contains` and `not`, and `contains` takes a list. Outcomes, behaviors and constraints take `refs`, the ids of an outside spec they restate, shown in the run output and the outcome diff and never part of a promise. See [0016](docs/decisions/0016-outcomes-check-headers-text-and-host.md).
- Constraints see `response.headers`.
- A fetch-style app (Hono, Next.js, a Worker) gets its request URL from `given.headers.host`, and `https` with `x-forwarded-proto: https`. Before, it was always `http://localhost`.
- Change files (0012) amend `headers` by name and replace `text`.

## 0.16.1 (2026-10-23): no green checks on a placeholder

- **Fix:** `oodle init` in a project it can't run (a `wrangler.toml`/`.jsonc` Cloudflare Worker, Deno, Python, Go, Ruby, Rust, the JVM, PHP, Elixir, or a `src/` with no server it recognises) no longer drops a starter app into `src/` and says "Project ready". It stops with `unsupported-stack`, names the file that gave the stack away, and points at `--app` and `--inventory`. Before, every check went green while testing the placeholder.
- **Fix:** `oodle doctor` fails with "Not ready" when the starter app is the configured app and such code sits beside it, so a project an older `init` set up this way says so.
- A fresh `init` says "Starter project ready" and that `src/app.ts` is a placeholder.
- `oodle mutate` no longer says outcomes "may be merged or dropped". It lists them as **overlapping** in this sample, with what else caught their bugs, and says a sample misses bugs and that an outcome guarding security or backing a constraint earns its place. The JSON adds `overlap` (`id`, `kills`, `also_caught_by`) next to `redundant`, which keeps its meaning.
- Proposed outcomes for `GET /` are `get-root`, not `get`, and a route that answers an HTML page names its title in the drafted statement.

## 0.16.0 (2026-10-23): stubs and request bodies from traffic

- **Changes:** `oodlc/config.yaml` takes a `proposed` section. `oodle propose --stubs --from <file>` writes stubs there from the outbound calls in a HAR capture or OTLP trace export that the app's `effects` rules name: the answer seen most, its status, its median latency, and observed evidence. No run reads `proposed`; a person accepts a stub by moving it into `defaults.given.stubs`. Every other status seen becomes a proposed condition. See [0015](docs/decisions/0015-stubs-and-bodies-from-traffic.md).
- `oodle propose --routes --from <file>` probes each route nothing describes with a body a caller really sent, and proposes it as the outcome's `given.body`.
- Captures are scrubbed as they are read. Every header but `content-type` is dropped, and so are query strings; paths lose their ids. Bodies keep their keys, numbers and short codes, and everything else becomes a deterministic placeholder (emails, card and phone numbers, IP addresses, tokens, names, free text). No flag keeps real values.
- The MCP `propose` tool takes `draft: stubs` with `from`, and `from` with `draft: routes`. `oodle doctor` lists stubs waiting to be accepted, and the Claude Code hook asks before an edit accepts one.
- `httpApp` and `nextApp` expose `effectKindOf(url, method)`, so traffic is classified as a run would classify it.

## 0.15.1 (2026-10-23): captured paths are scrubbed

- **Fix, privacy:** since 0.11.0, `oodle discover --from` wrote concrete paths from a HAR capture or trace export into `oodlc/proposed.yaml` and its output, in the question about requests no route serves. A token, an email or a record id in a path went in as it was. Paths are now scrubbed as each file is read: the query string goes, and every segment that isn't a plain lowercase word becomes a parameter (`/password-reset/eyJ…` is `/password-reset/:id`). An asset keeps only its extension. Raw captured paths no longer reach the catalog, the terminal or the JSON. If you ran `discover --from` on a capture with secrets in its paths, check `oodlc/proposed.yaml` for `unrouted.` questions. See [0015](docs/decisions/0015-stubs-and-bodies-from-traffic.md).

## 0.15.0 (2026-10-23): outcomes drafted from what a person confirmed

- `oodle propose --routes` drafts each outcome's statement from its capability when a person has confirmed it and it says what it does: the capability's words, then what the probe saw ("A shopper can look up one of their orders. Asked for a made-up id, GET /orders/:id answers 404 (order_not_found), with no outside call or write."). Under a capability nobody confirmed, the statement stays a TODO that names it. Either way it is a proposal.
- `oodle propose --capabilities` proposes an outcome for each surface of each confirmed capability no outcome protects yet, from a probe or from the behavior that already runs the route. Running it again adds nothing. Also `draft: capabilities` (and `draft: routes`) on the MCP `propose` tool, which returns the same JSON as the CLI.

## 0.14.0 (2026-10-23): what was seen, and what was said

- **Changes:** each piece of `evidence` on a capability or experience is `{ text, grade }`, and the grade is `observed` (Oodle saw it: a route the app serves, a probe, a recorded call or table write, a request in a capture or trace) or `inferred` (someone wrote it: a spec's words, an agent's draft, anything else). Plain text, or an item with no grade, loads as `inferred`, so older catalogs load as they are. See [0014](docs/decisions/0014-evidence-grades.md).
- Only `oodle discover` writes `observed`. `oodle propose` and the MCP `propose` tool grade every item they are given `inferred`, the MCP `answer` tool refuses evidence, and the Claude Code hook asks the person before an edit adds observed evidence.
- Only observed evidence ranks: traffic orders capabilities in `discover` as before, and `oodle interview` now asks first about the capabilities with the most observed evidence, not the most lines.
- `oodle explain` shows the grade beside each piece of evidence, and marks a capability **inferred only** when nothing Oodle saw backs it (no observed evidence, and nothing of its own ran). `inferred_only` is in its JSON, per capability and in the summary, and in the `map` tool.
- **Not seen is not unused.** `oodle discover --from` records what each file covered (kind, first and last request, request count, hosts), prints it, and returns it as `scope` in the JSON. A capability no captured request reached gets an `unseen.<id>` question that cites it: "Not seen in 1 HAR capture, session.har (40 min, 312 requests, hosts: …). That doesn't mean it's unused." It is asked of existing capabilities too. The `unused.<id>` question and the `no requests in <file>` evidence line are gone.
- `oodle discover` adds `<route>: served by the app` (observed) to each capability it drafts in a project with an app.

## 0.13.0 (2026-10-23): agree the change before the code, and say what the words mean

- **Changes** in `oodlc/changes/`: why, the capabilities a change may reach, how it amends outcomes and constraints, and what it rules out (new effects, hosts, routes, dependencies). Once merged, `oodle check` covers a code pull request that does exactly that: the item names the change it is covered by and doesn't block, and the comment cites the commit that agreed it. What moves outside the change blocks as outside intent. Only changes on the base count. See [0012](docs/decisions/0012-changes-merge-intent-before-code.md).
- `oodle changes` lists them, `oodle changes brief <id>` (and the MCP `change` prompt) briefs a coding agent, and `oodle changes fold <id>` writes a shipped change into the catalog and archives it.
- The Stop hook sends outside-intent findings and unmet amendments back to the agent.
- **Terms**: what words like "order" or "customer" mean here, with `aka` for the other words people use. The vocabulary comes from what the routes act on and the actors. Once a catalog defines one term, lint flags the vocabulary's other words its statements use undefined, and a word defined twice is an error. `oodle interview` asks what each means and writes `oodlc/terms.yaml`; `oodle explain` prints the glossary; the drafter uses it. See [0013](docs/decisions/0013-terms.md).
- Lint counts an outcome toward the capability whose surfaces reach its trigger, as `oodle explain` does, so a capability those outcomes protect is no longer reported as having none.

## 0.12.0 (2026-10-23): explain any system

- **Changes:** `app` in `oodlc/config.yaml` is optional. A project without it explains a system Oodle can't run, in any language, and protects nothing. `oodle init --inventory` starts one. See [0011](docs/decisions/0011-explain-what-oodle-cannot-run.md).
- With no app, `oodle discover --from` takes its routes from the evidence: the spec's operations, and traffic on the service's own host templated (`/orders/ord_1` becomes `/orders/:id`).
- In a project with no app, `oodle run` says nothing runs, `oodle check` reports inventory changes, `oodle mutate` and `oodle propose --routes` refuse with `no-app`, and outcomes, behaviors, conditions and constraints are lint errors.
- OpenAPI operations carry the spec's host, so traffic to other sites is told apart.

## 0.11.0 (2026-10-23): evidence from outside the code

- `oodle discover --from <file>` reads an OpenAPI spec, a HAR capture or an OTLP JSON trace export. The spec's own words go into each capability's evidence and draft statement. Traffic counts each route's real use and puts the most used capabilities first, and journeys callers repeat become proposed experiences. Assets and other sites' requests are left out. Routes in the spec the app doesn't serve, traffic no route answers, and capabilities no request reached each become a question. Also `from` on the MCP `discover` tool.
- `oodle interview` asks about experiences too: what people are trying to get done, and what would make it feel broken. The MCP `answer` tool takes `feels_broken_when`.
- Experiences take `evidence`.

## 0.10.0 (2026-10-23): the system map

- `oodle explain` prints the system map: each intent, its capabilities and experiences, who each capability is for, the routes that reach it, whether its outcomes hold, and the next rung it needs. `--only` shows capabilities in full; `--format md` writes a page. Also the `map` MCP tool.
- An outcome or behavior with no `capability` belongs to the capability whose routes reach its trigger, so coverage shows before anyone links them.
- `oodle mutate` adds a by-capability tally when the catalog has capabilities: the planted bugs each capability's outcomes catch, and how many nothing outside it catches (`capabilities` in the JSON).
- The outcome diff (terminal, PR comment and JSON) gains a report-only capabilities section: which capabilities a change reaches, and the ones it adds, removes, confirms or rewords.

## 0.9.0 (2026-10-23): describing the system

- The catalog gains an inventory: `actors`, `capabilities`, `experiences` and `unknowns`. It explains the system and never blocks. A catalog of capabilities alone is valid. See [0010](docs/decisions/0010-capabilities-and-the-inventory.md).
- **Changes:** an outcome traces to an intent, a confirmed capability, or both. An outcome with neither is still an error, now worded "outcome traces to nothing". Outcomes and behaviors take an optional `capability`.
- `oodle discover` proposes the capabilities a project's routes add up to, each with its evidence, and open questions for a person. Also an MCP tool. `oodle propose --routes` links the outcomes it drafts to the capability that lists their route.
- `oodle interview` asks a person what only they can say about each capability (what it does, for whom, why), shows the evidence, and writes the answers in place. Agents get the same interview as the `interview` MCP prompt and record answers with the `answer` tool, which never confirms. Unknowns take an `answer`.
- `oodle propose` accepts the new sections and marks actors, capabilities and experiences as proposed. The MCP `catalog` tool lists them, the drafter asks for them, and the Claude Code hook asks before a capability is confirmed.

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
