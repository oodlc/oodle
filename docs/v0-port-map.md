# v0 port map

What exists in v0 (tag `v0.19.0`, `src/`), and what the new line does with it. Port only what the current phase needs; this map says which phase that is.

Decisions: **port** (as is, maybe renamed), **port with changes**, **reference** (read it, write new code), **archive** (stays at `v0.19.0`).

v0 had no Miniflare: it ran Workers in process (`src/workers.ts`) with D1 on `node:sqlite` (`src/sqlite.ts`). The implementation guide makes Miniflare the reference runner and keeps the in-process path as an optional fast mode.

## Asked about by the guide

| v0 component | Files | Decision | Phase | Notes |
| --- | --- | --- | --- | --- |
| Sealed runner | `seal.ts` (patches `net.Socket#connect` and `fetch`, records escapes), `runner.ts` (`runProject`, `runSubject`, `FIXED_NOW`) | **port with changes** | 2 | Miniflare's outbound service replaces the socket patch for the Worker itself; the process-level seal still guards the harness (and the fast mode). `runner.ts` is built around outcomes and conditions; only its shape (seal, open db, run, collect, unseal) carries over. |
| SQLite simulation (D1) | `sqlite.ts` (`SqliteDatabase`, `D1Database`, `D1PreparedStatement`, write recording, injection refusal) | **port with changes** | 2 (fast mode, behind a flag) | Miniflare's own D1 is the reference. Keep v0's D1 shim for the in-process fast mode. Write recording (`db.<table>.inserted`) is not an `Observation` field yet; drop it until something needs it. |
| Postgres simulation | `database.ts` (PGlite + wire-protocol bridge) | **archive** | — | The slice is D1 only. |
| Workers in process | `workers.ts`, `workers-hooks.mjs`, `workers-cf/*` (env from wrangler, bindings, `cloudflare:` modules, HTMLRewriter) | **port with changes** | 2 (fast mode only) | Needed only if the fast mode is built. `readWrangler`/JSONC parsing may be reused by the generator's static checks (phase 3). |
| Matchers | `expect.ts` (`matchValue`, `getPath`, `stableStringify`, `MATCHER_KEYS`, `jsonDiff`, `effectDiff`) | **port** `stableStringify`, `matchValue`, `jsonDiff`; **archive** `evaluate`/`effectDiff` | 1 (`stableStringify` for the spec hash), 3 (`matchValue` for journey `expect`) | `evaluate` is tied to v0's `Expect` (status/body/effects); journeys now expect against a `ViewModel` and mail. |
| Differ | `diff.ts` (`diffRuns`, outcome/behavior/constraint diffs, approvals, `boundaryView`) | **reference** | 4 | v0 diffs one app before/after a change, by outcome id. The new differ diffs two builds by scenario step, over `Observation`s, then clusters into gap signatures. Keep the idea of a "boundary view" (what someone outside sees) — that is now `ViewModel` + mail + status. |
| Change files (0012) | `changes.ts` (`coverage`, `outsideIntent`, `originOf`, `foldChange`, base-ref reading via git), `runner.ts` (`directDeps` for "new dependencies") | **port with changes** | 9 | The "only changes on the base count" logic (reading from the base ref, not the working tree) carries over to intents. Amendments become structured `changes` patches on the declared tier. `RULED_OUT` (`new effects`, `new hosts`, `new routes`, `new dependencies`) maps to `rules_out`. |

## Everything else

| v0 component | Files | Decision | Notes |
| --- | --- | --- | --- |
| App contract | `contract.ts` (`createApp(ctx)`, `ctx.effects`, `ctx.id`, `ctx.now`) | **reference** | Same idea as `@oodle/runtime` (`rt(c).now()`, `rt(c).id()`), reshaped for Hono context bindings (phase 2). |
| HTTP adapters | `adapter.ts`, `next.ts`, `next-routes.ts` | **archive** | Generated apps are Hono on Workers only. |
| Catalog and config loading | `catalog.ts`, `spec/*.schema.json`, `types.ts` | **reference** | The new spec has six kinds of entry and zod schemas. v0's YAML Document-API writing (comment-preserving) is the pattern to follow in `@oodle/spec`. |
| YAML writers | `interview.ts`, `changes.ts`, `propose.ts` (all use `parseDocument`) | **reference** | Pattern for comment-preserving writes (phase 1). |
| Interview | `interview.ts` | **archive** | Was about confirming discovered capabilities; the new interview writes the declared tier from nothing (section 12). |
| MCP server | `mcp.ts` | **reference** | The "agents can only propose" stance carries over to `oodle mcp` (phase 6+). |
| Security pack | `security.ts` (injection payloads, fuzz) | **archive** | Revisit when constraints need hostile inputs ("field edges, wrong type" in the exploration plan is the nearest thing). |
| Evidence grades, discovery, scan, propose, draft, terms, lint, explain | `evidence.ts`, `discover.ts`, `scan.ts`, `propose.ts`, `draft.ts`, `terms.ts`, `lint.ts`, `explain.ts` | **archive** | Code-first concepts the reset dropped (0019). |
| Traffic capture and scrubbing | `traffic.ts`, `scrub.ts` | **archive** | Comes back with traffic replay (a later, non-goal item). `scrub.ts`'s "keep only what looks safe" rule is worth reusing then. |
| Mutation testing | `mutate.ts` | **archive** |  |
| Report and render | `report.ts`, `render.ts`, `ui.ts`, `ui.html` | **archive** | The web inbox replaces the HTML report. |
| CLI | `cli.ts`, `completion.ts`, `invocation.ts`, `doctor.ts`, `init.ts`, `ci.ts`, `hooks.ts`, `bin/oodle.js` | **reference** | New CLI in `packages/cli`.`errors.ts` (`OodleError`, `suggest`) and `term.ts` (terminal styling) are small enough to **port** when the CLI needs them (phase 3). |
| GitHub Action, Claude Code plugin | `action.yml`, `scripts/action.sh`, `integrations/claude-code` | **archive** |  |
| Tests | `test/*` | **reference** | `test/workers.test.ts` and `test/database.test.ts` are the useful ones to read when porting the fast mode. |
