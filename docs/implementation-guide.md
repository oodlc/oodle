# Oodle implementation guide (Cloudflare stack)

**Audience:** Claude Code, working in the Oodle repository.
**Companion to:** `VISION.md` (the model; the guide originally said `README.md`) and `docs/decisions/0019-reset-the-spec-is-the-product.md`.
**Status:** build plan for the first slice plus the remote inbox. Where this guide and VISION.md disagree, VISION.md wins on *what*, this guide wins on *how*. Flag any disagreement instead of resolving it silently. Decisions taken while building are in `docs/decisions/` (0020 onward).

---

## 0. How to work through this guide

1. Read `VISION.md` fully before writing code. The six entry kinds, the two tiers and the rules section are the contract.
2. Before Phase 1, inspect the v0 archive (tag `v0.19.0`). Write `docs/v0-port-map.md` listing what exists for: the sealed runner, the SQLite simulation, matchers, the differ, change files (decision 0012). For each: port as is, port with changes, or leave in the archive. **Port only what the current phase needs.**
3. Work phase by phase (section 14). At the end of each phase: run its acceptance checks, commit, and report (what was built, what was deferred, what you had to decide).
4. When this guide leaves something open, pick the simplest option, record it as an ADR in `docs/decisions/` (next number), and keep going.
5. Never weaken a rule from VISION.md's rules section to make something easier. If a rule blocks you, stop and say so.

### Non-goals for this guide

- Release checks (traffic replay, canary). Stubs and interfaces only.
- Stacks other than Hono + Workers + D1 for generated apps.
- Multi-tenant SaaS concerns for the inbox beyond what section 10 describes (no billing, no orgs UI).

---

## 1. Architecture at a glance

```
┌──────────────────────── developer machine / CI ────────────────────────┐
│                                                                        │
│  oodle/ (spec, in git)  ◄──── source of truth                          │
│     │                                                                  │
│  oodle CLI ──► generator (Claude Agent SDK) ──► .oodle/builds/<id>/    │
│     │                                              │                   │
│     ├──► simulation (Miniflare, sealed) ◄──────────┘                   │
│     ├──► differ ──► gaps (oodle/gaps/*.yaml)                           │
│     └──► sync client ───────────────┐                                  │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      │ HTTPS, project token
┌─────────────────────────── Cloudflare ┼────────────────────────────────┐
│  inbox Worker (Hono)  ◄──────────────┘                                 │
│    ├─ D1: projects, gaps, answers, intents, approvals, tokens, events  │
│    ├─ static assets: web UI (React + Vite)                             │
│    └─ Cloudflare Access in front of /app and /api/ui/* (humans)        │
└────────────────────────────────────────────────────────────────────────┘
```

Three principles drive every design choice below:

1. **Local-first.** Everything except the web inbox works offline with no account. The remote is an optional sync target.
2. **The spec in git is the only source of truth.** The remote holds an inbox (questions, answers, approvals). An answer counts only once it has been applied to the spec and committed.
3. **Route by tier.** Agents may settle decided-tier gaps locally. Declared-tier gaps and intent approvals go to people, usually through the web inbox.

---

## 2. Repository layout

pnpm workspace, TypeScript everywhere, Node 22+, ESM only.

```
packages/
  spec/          @oodle/spec        zod schemas, loader, validator, tier guard, writers
  runtime/       @oodle/runtime     clock/ids/random/mail/outbound for generated apps
  template/      @oodle/template    Hono + D1 app skeleton the generator starts from
  generator/     @oodle/generator   drives Claude Code headless, collects decisions
  sim/           @oodle/sim         Miniflare runner, driver harness, observations
  compile/       @oodle/compile     journey + exploration compiler (LLM, cached)
  diff/          @oodle/diff        normalizer, differ, gap signatures
  gaps/          @oodle/gaps        question writer, tier classifier, gap store
  sync/          @oodle/sync        sync client, answer applier
  cli/           oodle              the CLI (commander or citty)
apps/
  inbox/                            Cloudflare Worker: API + web UI
    src/worker/                     Hono app
    src/web/                        React app (Vite)
    migrations/                     D1 migrations
    wrangler.jsonc
examples/
  dogwalk/oodle/                    the README example, used by all end-to-end tests
docs/
  decisions/
  v0-port-map.md
```

Tooling: `vitest` for unit tests, `@cloudflare/vitest-pool-workers` for the inbox Worker tests, `tsup` for building packages, `biome` for lint and format. Check current versions of Wrangler, Miniflare, Hono and the Claude Agent SDK before pinning; do not rely on memory for their APIs.

---

## 3. The spec on disk

### 3.1 Files

```
oodle/
  intent.yaml          # declared
  personas.yaml        # declared
  domain.yaml          # declared
  journeys/*.yaml      # declared, one journey per file
  constraints.yaml     # declared
  decisions.yaml       # decided (plus person overrides)
  intents/*.yaml       # change intents (section 9)
  gaps/*.yaml          # open and settled questions (section 7)
  compiled/            # derived, committed: compiled journeys + exploration plan
  oodle.config.yaml    # project settings: stack, remote, routing policy
.oodle/                # gitignored: builds, sim databases, caches, logs
```

The README's single-file YAML example must also load (a single `oodle/spec.yaml` with all sections). The loader accepts either layout and normalizes to one in-memory `Spec`.

### 3.2 Schemas (`@oodle/spec`)

Write zod schemas for each kind. Keep them permissive on prose and strict on structure. Sketch:

```ts
const Persona = z.object({
  can: z.array(z.string().min(1)),           // capability phrases, become the action vocabulary
  cannot: z.array(z.string()).optional(),
});

const Entity = z.object({
  fields: z.record(z.union([z.string(), z.array(z.union([z.string(), z.number()])), z.null()])),
  states: z.string().optional(),             // "requested -> accepted -> done | declined | cancelled"
  rules: z.array(z.string()).default([]),
});

const JourneyStep = z.string();              // natural language, compiled later (section 5)
const Journey = z.object({ id: z.string(), persona: z.string(), steps: z.array(JourneyStep) });

const Constraint = z.object({
  text: z.string(),
  check: z.enum(['build', 'production', 'generator']),   // inferred if absent, see 3.4
});

const Decision = z.object({
  id: z.string(),                            // "d_" + short hash of normalized text at creation
  text: z.string(),                          // in the spec's own words
  about: z.array(z.string()).default([]),    // refs: "entity:walk", "journey:first-booking", "screen:walks"
  source: z.enum(['generator', 'person']),
  status: z.enum(['pinned', 'rule', 'dont_care']),
  created_by_build: z.string().optional(),
  answered_by: z.string().optional(),        // identity of the person, when source = person
  from_gap: z.string().optional(),
});
```

Short-form entries (a bare string under `constraints:` or `decisions:`, as in the README) are accepted and expanded: a bare decision string becomes `{source: generator, status: pinned}` with a computed id, written back in long form the next time the CLI writes the file. Preserve comments and key order when writing YAML (use the `yaml` package's Document API, not `JSON.stringify` round trips).

### 3.3 Spec hash

`specHash(spec, {tiers})` is a stable hash over the normalized declared tier, decisions, and merged intents. Builds, compiled artifacts and gap runs are keyed by it. Formatting, comments and gap files do not change it.

### 3.4 Constraint classification

If a constraint has no `check`, classify it once with a small LLM call (cached by text hash) into `build` (checkable in simulation: permissions, privacy, idempotency, limits, simulated time budget), `production` (p95, p99, error rate, availability), or `generator` (stack, data volume, retention, residency). Write the classification back as an explicit field so people can correct it. `production` constraints are recorded and reported, never block.

### 3.5 The tier guard

`assertDeclaredUnchanged(before: Spec, after: Spec)` fails if anything in the declared tier differs. The generator workflow calls it after every agent run (section 4.4). The CLI calls it before committing anything an agent produced. This is how "only people change the declared tier" is enforced mechanically, not by prompting.

---

## 4. Generated apps and `oodle build`

### 4.1 The runtime contract (`@oodle/runtime`)

Determinism is the foundation of the gaps check: two runs of the same build must give identical answers. Generated code is therefore forbidden from touching nondeterministic globals directly. It gets them from `@oodle/runtime`:

```ts
import { rt } from '@oodle/runtime';

rt(c).now()                 // Date
rt(c).id('walk')            // string id
rt(c).random()              // number in [0,1)
rt(c).mail.send({ to, subject, text })
rt(c).fetch(url, init)      // all outbound HTTP
rt(c).log(event, data)      // structured log, never user-visible
```

`rt(c)` reads from the Hono context's bindings. Two implementations:

- **production**: real clock, `crypto.randomUUID()`-style ids, real mail provider via outbound fetch.
- **simulation**: clock controlled by the harness (`OODLE_SIM_CLOCK` via a control binding), ids `walk_1`, `walk_2`… per kind, seeded PRNG, mail and outbound fetch captured into an outbox the harness reads.

The mode is chosen by an env var binding (`OODLE_MODE=sim|prod`). Enforcement: a static check in `oodle verify` (section 6) fails the build if generated source references `Date.now`, `new Date()` with no argument, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, or global `fetch`. Use an AST check (ts-morph or oxc), not grep.

### 4.2 The template (`@oodle/template`)

The generator never starts from an empty directory. The template contains:

```
src/index.ts            Hono app, error handler, session middleware, rt wiring
src/oodle.driver.ts     driver stub (section 5.2), the generator fills it in
migrations/             empty, generator adds D1 migrations
wrangler.jsonc          name, main, compatibility_date, d1_databases (binding DB), vars OODLE_MODE
package.json            hono, @oodle/runtime
AGENTS.md               rules for the generator (generated from the spec, section 4.3)
```

Auth in generated apps for the first slice: a minimal session cookie keyed by a persona user id, issued by a sim-only `/__oodle/login?user=` route that returns 404 when `OODLE_MODE=prod`. Real auth is a constraint people add later; do not invent one.

HTML rendering: server-rendered with Hono JSX. No client framework in the first slice. This keeps "what a user sees" extractable without a browser (section 5.4).

### 4.3 The generator prompt contract

`AGENTS.md` in the build workspace is generated from the spec and contains, in this order:

1. The intent, personas, domain, journeys and constraints, verbatim.
2. Every decision in `decisions.yaml` with status `pinned` or `rule`, stated as requirements: "You must keep these exactly."
3. The rules:
   - Do not edit anything under `oodle/` except `oodle/decisions.proposed.yaml`.
   - Use `@oodle/runtime` for time, ids, randomness, mail and outbound HTTP.
   - Implement every action in `src/oodle.driver.ts` (one per persona capability, names given).
   - Wherever the spec is silent and you choose something a user could notice, append a decision to `oodle/decisions.proposed.yaml` in plain words, with `about:` refs. Do not record internal choices (variable names, file layout, library internals).
   - If something in the spec is contradictory or impossible, write `oodle/blocked.yaml` explaining why and stop.
4. The stack constraints, and the list of anything ruled out by merged intents (dependencies, outside services, routes).

### 4.4 Running the generator (`@oodle/generator`)

Use the Claude Agent SDK (TypeScript, headless). Verify the current package name and `query()` options against the docs before writing this.

```
oodle build [--from <buildId>] [--seed <n>]
  1. load spec, compute specHash
  2. create .oodle/builds/<buildId>/  (buildId = specHash[:8] + "-" + seed)
  3. copy template (or the previous build's code when --from is given, for incremental changes)
  4. write AGENTS.md, a read-only copy of oodle/ into the workspace
  5. run the agent with cwd = workspace, tools limited to file edit/read and shell
     restricted to: pnpm install, pnpm typecheck, wrangler d1 migrations apply --local
  6. after the run:
     a. assertDeclaredUnchanged(spec, workspaceSpec)       -> fail build if violated
     b. if blocked.yaml exists                             -> stop, surface it
     c. typecheck + determinism AST check                  -> fail build if violated
     d. read decisions.proposed.yaml, dedupe against decisions.yaml (section 4.5)
  7. write .oodle/builds/<buildId>/manifest.json:
     { buildId, specHash, seed, startedAt, endedAt, agentTranscriptPath, proposedDecisions, status }
```

Independent builds for the gaps check must not share anything except the spec and the template: separate workspaces, separate agent sessions, no `--from`.

Cost control: cache builds by `(specHash, seed)`. `oodle gaps` reuses build A when its key matches.

### 4.5 Capturing decisions

Two sources, merged:

1. **Written by the generator** in `decisions.proposed.yaml` while it builds.
2. **Inferred from gaps** (section 7): when two builds differ, each side's behavior is a candidate decision.

Dedupe proposed decisions against existing ones with a cheap similarity pass (normalized text + `about` overlap), then an LLM judge only for near matches. A proposed decision that **contradicts** a pinned one is not merged: it becomes a gap with `kind: decision_moved`, which blocks the build (README rule: the generator never changes a decision silently).

New, non-contradicting decisions are appended to `oodle/decisions.yaml` with `source: generator, status: pinned` only after the build passes `verify`. Granularity guidance for the prompt and the dedupe step: one decision per user-noticeable behavior, phrased so a non-engineer can agree or disagree with it. Record an ADR if you change this.

---

## 5. Simulation

### 5.1 Runner (`@oodle/sim`)

Run each build's Worker in Miniflare (programmatic API), sealed:

- D1 bound to a fresh local database per run, migrations applied from the build.
- `OODLE_MODE=sim`, seed and starting clock passed as bindings.
- Outbound network blocked: route all outbound through a Miniflare outbound service that records the request and returns a canned response. Any request that bypassed `rt(c).fetch` still lands here and is reported.
- One Miniflare instance per (build, scenario). Scenarios run in parallel across instances, steps within a scenario run serially.

Port v0's sealed runner and SQLite simulation where they fit (see `docs/v0-port-map.md`). If v0 ran D1 through better-sqlite3 in process, keep that path as a fast mode behind a flag, but Miniflare is the reference.

### 5.2 The driver

Journeys and exploration talk to the app through **actions**, not routes, because two builds can choose different routes. The action vocabulary comes from personas: each `can` phrase becomes an action id (`owner.book_walk`, `walker.accept_walk`…). The compiler (5.3) derives the ids and input shapes once and writes them to `oodle/compiled/actions.json`; the generator must implement exactly these.

```ts
// src/oodle.driver.ts (generated per build)
import type { Driver } from '@oodle/sim/driver';
export const driver: Driver = {
  actions: {
    'owner.book_walk': async (s, input) => { /* s.fetch(...) as this persona */ return { screen: '/walks/' + id }; },
    // one per action in compiled/actions.json
  },
  screens: {
    home: (s) => '/',            // named screens the compiler references
  },
};
```

`s` is a persona session from the harness: a cookie jar plus `s.fetch` bound to the Miniflare instance. Each action returns the screen the user lands on. The harness, not the driver, reads what is on that screen. `verify` fails if any compiled action is missing from the driver.

Risk to note in the code: the driver is generated, so a bad driver can hide app behavior. Mitigation in this slice: actions must go through HTTP (enforced by giving the driver only `s.fetch`), and observations are taken by the harness.

### 5.3 Compiling journeys and exploration (`@oodle/compile`)

Journey steps are prose. Compile each journey once, with an LLM, into structured steps, cached by hash of (journey text + personas + domain):

```json
{
  "journey": "first-booking",
  "steps": [
    { "at": "2026-11-02T08:00:00Z", "as": "owner:ada", "do": "owner.book_walk",
      "input": { "walker": "walker:sam", "starts_at": "2026-11-03T09:00:00Z", "minutes": 30 },
      "expect": { "screen_contains": ["Requested", "$20"] } },
    { "as": "walker:sam", "do": "walker.accept_walk", "input": { "walk": "$walk_1" },
      "then_as": "owner:ada", "expect": { "screen_contains": ["Accepted"], "mail_to": "owner:ada" } }
  ],
  "fixtures": { "owner:ada": { "name": "Ada" }, "walker:sam": { "name": "Sam" } }
}
```

Write compiled output to `oodle/compiled/journeys/<id>.json` and commit it, so every build runs identical requests and people can inspect it. Recompile only when its hash changes. `oodle compile --check` shows the compiled form next to the prose for a person to sanity-check.

**Exploration plan** (`oodle/compiled/explore.json`), also compiled once, deterministically from the domain and personas with a fixed seed. This is what finds gaps the journeys don't touch. Generate scenarios for:

- **Collections**: each list a persona can see with 0, 1, 7 and 60 items (empty states, sort order, pagination).
- **Permission matrix**: every persona × every action, including on records they don't own.
- **State machine**: every allowed transition, plus every disallowed one.
- **Rule boundaries**: values just inside, at, and just outside each rule ("cancel 2h before": at 2h01, 2h00, 1h59).
- **Field edges**: each field empty, at min/max, wrong type.

Cap the plan (default 200 scenarios) and make the cap a config value.

### 5.4 Observations

For every step the harness records an observation, the only thing the differ compares:

```ts
type Observation = {
  scenario: string; step: number; as: string;
  status: number;                       // HTTP status of the action's final response
  view: ViewModel;                      // what is on the landing screen, extracted from HTML
  mail: { to: string; subject: string; text: string }[];   // sent during this step
  outbound: { host: string; method: string }[];
  blocked?: boolean;                    // action refused (4xx), normalized
};

type ViewModel = {
  title?: string;
  headings: string[];
  text: string[];                       // visible text blocks in document order
  lists: { items: string[] }[];         // order matters
  actions: string[];                    // visible buttons and links, by accessible name
  fields: { label: string; value?: string; error?: string }[];
};
```

Extract the view model with an HTML parser (linkedom or parse5), ignoring `script`, `style`, hidden elements, and attributes other than accessible names. Screens rendered by a real browser (Playwright) come later; keep `ViewModel` stable so the browser path produces the same shape.

---

## 6. `oodle verify`

Runs one build against the spec. Blocking, in order:

1. Static: typecheck, determinism AST check, driver completeness, ruled-out checks from merged intents (new dependencies in `package.json`, outbound hosts, new top-level routes compared to the previous passing build).
2. Journeys: run each compiled journey, check every `expect`. A failed expectation names the journey, step, prose line and what was observed.
3. Constraints with `check: build`: compile each into a property over observations once (cached, committed under `compiled/constraints/`), then evaluate across journeys and the exploration plan. Example: "No one sees another owner's address" becomes "no observation as `owner:X` contains a fixture address belonging to `owner:Y`".
4. Pinned decisions: compile each pinned decision into a check the same way. A decision that can't be compiled into a check is reported as a warning (`unchecked decision`) and listed by `oodle status`, never silently ignored.

Output: human-readable summary to stdout, full report to `.oodle/builds/<id>/verify.json`. Exit code non-zero on any blocking failure.

---

## 7. `oodle gaps`

```
oodle gaps [--journeys-only] [--scope intent:<id>]
  1. build A (reuse cache) and build B (fresh seed, fresh session)
  2. run both through journeys + exploration in simulation
  3. normalize and diff observations
  4. cluster differences into gap signatures
  5. write one question per gap to oodle/gaps/<gapId>.yaml
  6. classify tier and route (section 8)
```

### 7.1 Normalizing (`@oodle/diff`)

Before diffing, rewrite both sides so only user-visible differences remain:

- Ids: replace each generated id with a symbol by first appearance (`walk_1` → `⟨walk#1⟩`), per side.
- Timestamps in text: normalize format only when both sides represent the same instant; different instants are a real difference.
- Whitespace and case in headings: collapse whitespace, keep case (case is visible).
- Ignore: `outbound` entries going to the sim outbox for logging, `rt.log` output, HTTP headers, CSS classes.

Port v0's differ and matchers if they fit; the input shape changes to `Observation`.

### 7.2 Gap signatures

A raw diff produces many differences with one cause (a different sort order changes every list). Cluster:

1. Group differences by (view field kind, action, entity ref).
2. Within a group, detect known patterns first: same items different order (sort), same item different format (format), one side blocked (permission or rule), one side shows extra element (extra feature), different copy (wording), different count per page (pagination).
3. `gapId = "g_" + hash(pattern + action + entity + normalized summary of each side)`. Rerunning the check on the same spec produces the same ids, so no duplicates in the inbox.

### 7.3 The gap file

```yaml
id: g_7f3a91c2
status: open                 # open | answered | dismissed | applied
kind: sort_order             # sort_order | format | permission | rule | extra_element | wording | pagination | decision_moved | other
tier: decided                # decided | declared (section 8)
route: agent                 # agent | human
spec_hash: 9c1e…
found_in: [build:9c1e44ab-1, build:9c1e44ab-2]
about: [entity:walk, screen:walks, action:owner.list_walks]
question: Two builds disagreed on how walks are listed. Which order should owners see?
evidence:
  scenario: explore/collections/walks-7
  a: { summary: "Newest first", sample: ["Thu 9:00", "Wed 9:00", "Tue 9:00"] }
  b: { summary: "Soonest first by start time", sample: ["Tue 9:00", "Wed 9:00", "Thu 9:00"] }
options:
  - { id: a, label: "Newest first", becomes: { decision: "Walks are listed newest first" } }
  - { id: b, label: "Soonest first", becomes: { decision: "Walks are listed by starts_at, soonest first" } }
  - { id: dont_care, label: "Either is fine" }
answer: null                 # filled when answered
answered_by: null            # "agent:<model>@local" or "person:<email>"
answered_at: null
applied_in: null             # commit sha once applied to the spec
```

Question wording: one LLM call per gap, given the evidence, constrained to output the schema above. Questions use the spec's words and real example values from the scenario, never internal names.

`dismissed` is for false positives (the difference is not user-visible). Dismissals feed a per-project ignore list (`oodle/gaps/.ignore.yaml`) so the same non-difference isn't raised again.

### 7.4 When is the spec complete enough?

`oodle gaps` exits zero and prints "builds agree" when there are no open gaps after a run. `oodle status` shows open gaps by route and tier, unchecked decisions, and the last agreeing spec hash.

---

## 8. Routing and answering

### 8.1 Tier classification

A gap is **declared-tier** if any answer would require changing intent, personas, domain, journeys or constraints. Rules, in order:

- `kind: permission` or `kind: rule` → declared (permissions and domain rules are declared).
- The gap contradicts a journey expectation or constraint on one side → declared (one build is wrong; a person confirms which).
- `kind: decision_moved` → human, always (it touches something already pinned).
- Otherwise → decided.

When the rules don't settle it, one LLM call decides, biased toward `declared` on doubt. Record `tier` and the reason in the gap file.

### 8.2 Routing policy (`oodle.config.yaml`)

```yaml
routing:
  decided: agent        # agent | human  (agent = local agent may settle it)
  declared: human       # always human; the CLI rejects other values
  decision_moved: human # always human
remote:
  url: https://inbox.example.com
  project: dogwalk
  # token comes from OODLE_TOKEN or the OS keychain, never from this file
```

### 8.3 `oodle answer`

```
oodle answer <gapId> --option <id> | --text "<rule in plain words>" | --dont-care | --dismiss
oodle answer --auto        # local agent settles every open gap with route=agent
```

- **Agent answers** (`--auto`, or any non-TTY invocation) are allowed only for `route: agent`. The agent picks the option most consistent with intent and existing decisions and must state why in one sentence (`answer.reason`). For `route: human`, the CLI refuses and points to the inbox.
- **Human answers locally** are allowed for any route, only from an interactive TTY, and record `answered_by: person:<git user.email>`. This is a policy boundary, not a security boundary; document it as such.
- Answering writes the gap file. Applying (8.4) changes the spec.

### 8.4 Applying answers (`@oodle/sync` `applyAnswer`)

- Option with `becomes.decision` → add or replace the decision in `decisions.yaml` (`source: person` if a person answered, else `generator`; `status: pinned`; `from_gap`).
- `--text` from a person → if it reads as a rule about the domain, write it to the declared tier (domain rules or constraints) with a person-provenance comment; otherwise add it as a decision with `status: rule`. Ask the LLM which, show the edit, require confirmation in TTY. From the remote, the web UI made the choice explicitly (10.4).
- `dont_care` → decision with `status: dont_care`; verify skips it, the differ suppresses that gap signature.
- Then mark the gap `applied`, commit with message `oodle: apply g_xxx (<answered_by>)`, record the sha in `applied_in`.

The tier guard (3.5) allows declared-tier edits only through `applyAnswer` with `answered_by: person:*`.

### 8.5 Conflicts

- A person's answer always wins over an agent's.
- If an agent already applied an answer and a person answers differently, apply the person's answer as a new commit and record the replaced decision in the gap's history.
- Two people answering the same gap: first applied wins; the second is surfaced in the inbox as a conflict for the first answerer to resolve.

---

## 9. Intents (changing the app)

```yaml
# oodle/intents/2026-11-cancel-fee.yaml
id: i_cancel_fee
title: Charge half price for late cancellations
status: draft              # draft | in_review | approved | merged | rejected
why: Walkers lose income on late cancellations.
changes:                   # edits to the declared tier, as a structured patch
  - op: replace_rule
    entity: walk
    from: "An owner can cancel for free until 2 hours before starts_at"
    to: "An owner can cancel for free until 2 hours before starts_at; after that they pay 50%"
keeps:                     # must stay true
  journeys: [first-booking]
  constraints: ["An owner is never charged for a walk that didn't happen"]
rules_out: [new_dependencies, new_outbound_hosts, new_routes]
done_when:
  journeys: [late-cancellation]      # must exist and pass after the build
  evals: []
approvals: []              # [{ by: person:<email>, at: <iso>, via: inbox|cli }]
```

Flow:

1. `oodle intent new` scaffolds the file. People (or an agent drafting for them) fill it in.
2. `oodle intent review <id>` applies `changes` to a scratch copy of the spec, runs `oodle gaps --scope intent:<id>` on it (only journeys and exploration reaching the changed entities), and attaches resulting gaps to the intent. Status → `in_review`. Pushed to the inbox on sync.
3. Approval happens in the inbox or with `oodle intent approve <id>` in a TTY. Agents cannot approve.
4. Merge: the intent and its `changes` are applied to the spec in one commit on the main branch (normal git merge, or `oodle intent merge`).
5. **Only merged intents count**: `oodle build` reads intents from `git show <main>:oodle/intents/` (configurable base ref), never from the working tree. An intent added in the same change set as the code it would authorize is ignored. Port v0's change-file logic from decision 0012 for this.
6. After merge, `oodle build && oodle verify` runs with the intent's `keeps`, `rules_out` and `done_when` added to the checks.

---

## 10. The remote inbox (Cloudflare)

### 10.1 Shape

One Worker, `apps/inbox`, built with Hono, serving:

- `/api/v1/*` for the CLI (project token auth)
- `/api/ui/*` for the web app (Cloudflare Access auth)
- `/app/*` the web UI, as Workers static assets (single-page app fallback)

Storage: one D1 database. No Durable Objects in the first version; add one per project only if live updates (WebSocket) become a requirement, and record it as an ADR.

`wrangler.jsonc` sketch (verify keys against current Wrangler docs):

```jsonc
{
  "name": "oodle-inbox",
  "main": "src/worker/index.ts",
  "compatibility_date": "<today>",
  "assets": { "directory": "./dist/web", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] },
  "d1_databases": [{ "binding": "DB", "database_name": "oodle-inbox", "database_id": "<id>", "migrations_dir": "migrations" }],
  "vars": { "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com", "ACCESS_AUD": "<aud>" }
}
```

Build the web app with Vite and the Cloudflare Vite plugin if it fits; otherwise plain Vite output into `dist/web`.

### 10.2 D1 schema (`migrations/0001_init.sql`)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                 -- slug, matches oodle.config.yaml remote.project
  name TEXT NOT NULL,
  repo_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','answerer','viewer')),
  PRIMARY KEY (project_id, email)
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  hash TEXT NOT NULL,                  -- SHA-256 of the token, never the token
  label TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE gaps (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,                    -- gapId from the CLI, stable
  content_hash TEXT NOT NULL,          -- hash of the gap file minus answer fields
  status TEXT NOT NULL,                -- open | answered | dismissed | applied | superseded
  route TEXT NOT NULL,
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  body_json TEXT NOT NULL,             -- full gap file as JSON
  spec_hash TEXT NOT NULL,
  intent_id TEXT,                      -- when raised by an intent review
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX gaps_open ON gaps(project_id, status, route);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  gap_id TEXT NOT NULL,
  answer_json TEXT NOT NULL,           -- { option | text + target | dont_care | dismiss }
  answered_by TEXT NOT NULL,           -- person:<email> (from Access) or agent:<id>
  answered_at TEXT NOT NULL,
  seq INTEGER NOT NULL,                -- per-project monotonic, the sync cursor
  applied_sha TEXT,
  acked_at TEXT,
  FOREIGN KEY (project_id, gap_id) REFERENCES gaps(project_id, id)
);
CREATE UNIQUE INDEX answers_seq ON answers(project_id, seq);

CREATE TABLE intents (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  body_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,          -- approval binds to exact intent content
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  by_email TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT,
  seq INTEGER NOT NULL
);

CREATE TABLE events (                  -- append-only audit log
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE counters (project_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
```

Allocate `seq` inside a D1 batch (read counter, increment, insert) so answers and approvals have one per-project order.

An approval binds to the intent's `content_hash`. If the intent changes after approval, the approval no longer counts; the CLI shows it as stale.

### 10.3 CLI sync API

One endpoint keeps the client simple and idempotent:

```
POST /api/v1/projects/:project/sync
Authorization: Bearer <project token>

{
  "client": { "version": "0.1.0", "spec_hash": "9c1e…", "git_sha": "abc123" },
  "push": {
    "gaps":    [ { "id": "g_…", "content_hash": "…", "body": { …gap file… } } ],
    "intents": [ { "id": "i_…", "content_hash": "…", "body": { …intent file… } } ],
    "applied": [ { "answer_id": "a_…", "sha": "def456" } ],
    "superseded_gaps": ["g_…"]       // gaps that disappeared after a new gaps run
  },
  "cursor": 41                         // last seq the client has applied
}

200
{
  "answers":   [ { "id": "a_…", "gap_id": "g_…", "answer": { … }, "answered_by": "person:jp@…", "seq": 42 } ],
  "approvals": [ { "intent_id": "i_…", "content_hash": "…", "decision": "approve", "by": "jp@…", "seq": 43 } ],
  "cursor": 43
}
```

Server rules:

- Upsert gaps by `(project, id)`. If `content_hash` is unchanged, touch nothing. If changed and the gap is `open`, update the body. If changed and it already has an answer, keep the answer, mark the gap `open` again with a note that the evidence changed (the human should confirm).
- Agent-routed gaps the CLI already settled locally arrive with their answer in the body; store them as `applied` for the audit trail. They don't need a human.
- Never accept answers or approvals from a project token for `route: human` gaps or intents. Tokens can push and pull; they cannot answer for people.
- Everything written goes to `events`.

Client rules (`@oodle/sync`):

- `oodle sync` = push, then pull, then apply each pulled answer in `seq` order with `applyAnswer`, commit, then report `applied` on the next sync (or a second immediate call).
- Store the cursor in `.oodle/sync.json`. Re-pulling the same answers is harmless: applying is idempotent by `answer_id` (recorded in the gap file).
- If the working tree has uncommitted changes under `oodle/`, refuse to apply and say why.
- Offline or no remote configured: sync is a no-op with a one-line message. Nothing else in the CLI depends on it.

Optional: `oodle sync --watch` polls every N seconds for answers (useful when an agent is waiting on a human).

### 10.4 UI API (humans)

Behind Cloudflare Access. The Worker validates the `Cf-Access-Jwt-Assertion` header on every `/api/ui/*` request (verify signature against the team's JWKS, check `aud`, read `email`). Then check `members` for the project and role. Use `jose` for JWT verification; cache the JWKS.

```
GET  /api/ui/projects
GET  /api/ui/projects/:p/gaps?status=open&route=human
GET  /api/ui/projects/:p/gaps/:id
POST /api/ui/projects/:p/gaps/:id/answer
     { "option": "b" } | { "text": "...", "target": "decision" | "domain_rule" | "constraint" } | { "dont_care": true } | { "dismiss": true }
GET  /api/ui/projects/:p/intents?status=in_review
GET  /api/ui/projects/:p/intents/:id
POST /api/ui/projects/:p/intents/:id/review   { "decision": "approve" | "reject", "note": "..." , "content_hash": "…" }
GET  /api/ui/projects/:p/activity
POST /api/ui/projects/:p/tokens               owner only, returns the token once
```

Answers use optimistic concurrency: the client sends the gap `version` it saw; a mismatch returns 409 with the current gap.

Local development: `wrangler dev` with a dev-only header override for identity (`X-Oodle-Dev-Email`), enabled only when a `DEV_AUTH=1` var is set, and a test asserting it is off in the production config.

### 10.5 Web UI

React, routed client-side, minimal styling. Screens:

1. **Inbox**: open human-routed gaps across projects, grouped by project, then by intent (if any), then by `about` entity. Shows kind, question, age.
2. **Gap**: the question, then side A and side B rendered from `evidence` (sample values as they'd appear to the user, the scenario in plain words), the options as buttons, "Write a rule instead" (free text with a target picker: decision, domain rule, constraint), "Either is fine", "Not a real difference". Show which existing decisions this would add or replace.
3. **Intent review**: the intent's why, the declared-tier changes as a readable before/after, what it keeps and rules out, the gaps its review raised (must all be answered before approve is enabled), approve/reject with a note.
4. **Activity**: the event log, filterable.

No code view anywhere. That is the product's point.

---

## 11. CLI reference (target)

```
oodle init                     create oodle/ from a template or the README's example
oodle interview                conversational spec writing (TTY), writes declared tier
oodle compile [--check]        compile actions, journeys, exploration, constraints
oodle build [--seed n]         generate the app
oodle verify [build]           check a build against the spec
oodle gaps [--scope ...]       two builds, diff, questions
oodle answer ...               settle gaps (section 8.3)
oodle intent new|review|approve|merge|list
oodle sync [--watch]           push/pull with the inbox
oodle status                   open gaps by route, unchecked decisions, last agreeing spec
oodle login <remote-url>       store a project token in the OS keychain
```

Every command supports `--json` for agents. Every command that would need a person and has no TTY exits with a distinct code (3) and a message naming what needs a person and where (inbox URL when configured). Agents use that to know when to stop and wait.

Expose the same operations as an MCP server (`oodle mcp`) so a local agent can read the spec, list gaps and answer agent-routed ones without shelling out. The MCP server enforces the same routing rules as the CLI.

---

## 12. `oodle interview`

TTY conversation (Claude via the Anthropic SDK) that writes the declared tier. Keep it simple in the first slice:

1. Ask for the intent in one sentence. Write it.
2. Ask who uses it; for each persona, what they can do. Write personas.
3. Derive domain entities from the capabilities, ask about fields, states and rules per entity, one entity at a time.
4. Ask for one journey per persona with real example values ("walk me through Ada's first booking").
5. Ask the must-never-happen question and the stack question. Write constraints.
6. Validate with the schema after every write. Show the resulting YAML at the end.

The interview never writes decisions. Gaps-driven questions (section 7) are the interview's second half, and that is where most of the specification actually gets pinned.

---

## 13. Testing Oodle itself

- **Unit**: schema loading (both layouts), tier guard, spec hash stability, YAML round trip preserving comments, normalizer, gap signature stability, applyAnswer for each answer type, sync client idempotency.
- **Fixture apps**: two hand-written dogwalk implementations under `packages/sim/test/fixtures/` that differ in known ways (sort order, a permission, wording). The gaps pipeline must find exactly those gaps, with stable ids, and no others. This tests everything except the generator, cheaply and deterministically.
- **Inbox**: `@cloudflare/vitest-pool-workers` with D1 migrations applied; test token auth, Access JWT validation (with a test key), sync upsert rules, the "tokens can't answer human gaps" rule, approval staleness on content change, seq ordering under concurrent answers.
- **End to end** (slow, opt-in with `OODLE_E2E=1`, real API calls): `examples/dogwalk` through init → compile → build → verify → gaps → answer → sync against `wrangler dev`.

---

## 14. Phases and acceptance criteria

**Phase 0: groundwork**
- Workspace, tooling, `docs/v0-port-map.md`.
- Accept: `pnpm -r build && pnpm -r test` passes on empty packages; port map lists every v0 component with a decision.

**Phase 1: spec**
- `@oodle/spec`: schemas, loader (both layouts), writer preserving comments, spec hash, tier guard. `examples/dogwalk/oodle/` from the README.
- Accept: README example loads; editing a comment doesn't change the hash; editing a journey does; tier guard catches any declared-tier edit.

**Phase 2: runtime, template, simulation on hand-written apps**
- `@oodle/runtime`, `@oodle/template`, `@oodle/sim` (Miniflare runner, sealed outbound, driver harness, view model extraction). Two hand-written fixture apps.
- Accept: running the same scenario twice on one fixture gives byte-identical observations; any unsanctioned outbound request is reported.

**Phase 3: compile and verify**
- `@oodle/compile` for actions, journeys and constraints (cached, committed). `oodle verify` with static checks and journeys.
- Accept: fixture A passes `first-booking`; a fixture with a broken step fails with the journey, step and prose line named; determinism check flags a planted `Date.now()`.

**Phase 4: diff and gaps on fixtures**
- `@oodle/diff`, `@oodle/gaps`, exploration plan.
- Accept: on the two fixtures, exactly the planted differences become gaps, ids are stable across runs, tier classification puts the permission gap in `declared`.

**Phase 5: generator**
- `@oodle/generator` with the Agent SDK, AGENTS.md generation, post-run guards, decisions.proposed merge, build cache.
- Accept: `oodle build` on dogwalk produces an app that passes `verify`; a planted attempt to edit `oodle/personas.yaml` from the agent fails the build; proposed decisions land in `decisions.yaml` only after verify passes.

**Phase 6: the full local loop**
- `oodle gaps` with real builds, `oodle answer` (manual and `--auto`), routing policy, applyAnswer, `decision_moved` detection, `oodle status`, `--json`, exit code 3.
- Accept: on dogwalk, gaps → `answer --auto` settles decided-tier gaps and refuses declared ones; a rebuild keeps every pinned decision; a second `gaps` run raises no gap already answered.

**Phase 7: inbox Worker and sync**
- D1 migrations, `/api/v1/sync`, token auth, Access validation, `/api/ui/*`, `oodle login`, `oodle sync`.
- Accept: all inbox tests pass; a human answer posted through the UI API is pulled by `oodle sync`, applied, committed, and reported back as applied; a project token posting an answer to a human gap gets 403.

**Phase 8: web UI**
- Inbox, gap, intent review, activity screens.
- Accept: a person can settle every open human gap on dogwalk from the browser without touching the terminal, and the next local `oodle sync && oodle build && oodle verify` reflects their answers.

**Phase 9: intents**
- Intent files, review (scoped gaps), approval (CLI TTY and inbox), merge, merged-only reading from the base ref, keeps/rules_out/done_when in verify.
- Accept: the cancel-fee intent from section 9 goes draft → review → approve in the inbox → merge → build → verify green, with no one reading code; an intent added on the same branch as its build is ignored.

**Later (do not start without being asked):** Playwright screens behind the same `ViewModel`, interview improvements, GitHub App write-back for web answers, traffic replay, canary, Durable Object live updates, cost controls for gaps on large specs.

---

## 15. Things to leave open (record, don't decide)

These are VISION.md's open questions. Build so they can change, and log what you learn about each in `docs/open-questions.md` as you go:

- Decision granularity (4.5): track how many decisions a dogwalk build proposes and how many end up as gaps.
- What counts as user-visible (5.4, 7.1): track dismissals; frequent dismissals of one pattern mean the normalizer should drop it.
- Cost of building twice: record tokens and wall time per build in the manifest.
- Where generated code lives: for now `.oodle/builds/` plus a `oodle export <buildId> <dir>` command; committing generated code to a separate branch is a later decision.
