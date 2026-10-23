# 0011. A project with no app explains a system Oodle can't run

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Builds on:** [0010. The inventory explains the system](0010-capabilities-and-the-inventory.md)

## Context

Oodle runs Node.js services. Everything else (Python, Go, Ruby, Java, services Oodle can't load) gets nothing from it, although describing a system needs no runner: 0010's inventory is words, evidence and people's answers. Since 0.11.0, `oodle discover --from` reads that evidence from an OpenAPI spec, a HAR capture or an OTLP trace export, none of which depends on the language behind them.

`oodlc/config.yaml` requires `app`, so a team with a Python service can't keep an inventory at all.

## Decision

1. **`app` is optional.** A project without one is an *inventory project*: it explains a system and protects nothing. `oodle init --inventory` starts one.
2. **Routes come from evidence.** With no app to ask, `oodle discover` needs `--from`. A spec's operations are taken as they are; traffic on the service's own host (the spec's host, or else the one most requests went to) is turned into templates where no spec route covers it (`/orders/ord_1` becomes `/orders/:id`). Templates from traffic are inferences a person can rename.
3. **Nothing runs.** `oodle run` says so instead of reporting an empty run. `oodle check` reports what a change does to the inventory (0010's capabilities section) and blocks on lint errors only. `oodle mutate` and `oodle propose --routes` refuse with `no-app`.
4. **No promise without a runner.** In an inventory project, outcomes, behaviors, conditions and constraints are lint errors, so they block. A promise nobody checks would read as protection. Intents and the inventory are what such a project holds.
5. **The way up is one line.** Pointing `app` at a Node service turns an inventory project into a protected one, keeping every intent, capability and answer.

## Options considered

### A. Keep `app` required; only Node services get an inventory

- Good: one kind of project.
- Bad: the teams who most need to describe a system they can't easily test get nothing.

### B. Allow outcomes without an app, reported as "not checked"

- Good: teams could write promises ahead of a port to Node.
- Bad: an outcome diff full of unchecked outcomes looks like protection. The blocking rule ("only what a human declared can block") assumes what blocks was checked.

### C. Optional `app`; inventory only; promises need a runner (chosen)

- Good: any system can be explained, and protection is an upgrade, not a rewrite.
- Bad: two kinds of project. `oodle doctor`, `run` and `init` say which one this is.

## Consequences

- `spec/config.schema.json` no longer requires `app`. oodlc.com serves the schema from the repository.
- Explaining a system no longer depends on its language; protecting one still needs Node.
- The GitHub workflow works on an inventory project: the comment shows the capabilities a pull request adds, removes, confirms or rewords.

## Revisit if

- Oodle can run services in other languages; an inventory project then gains `app` like any other.
- Teams want outcomes they check elsewhere (their own tests, a staging probe) recorded here; that would need a way to bring those results in, not a promise with no check.
