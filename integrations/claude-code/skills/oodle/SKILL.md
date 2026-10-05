---
name: oodle
description: Work in a project guarded by Oodle (an oodlc/ folder at the project root). Use when building or changing features, writing or deleting tests, hardening security, or finishing a task in such a project; also when asked to draft outcomes from a brief, find weak or redundant tests, or explain an outcome diff.
---

# Working against an Oodle catalog

The `oodlc/` folder is the spec. **Outcomes** and **constraints** are approved by a person and block merges. **Behaviors** are observed and never block. Everything else (function names, internal effects, file layout) is yours to change.

## The loop

1. **Read the catalog first**: the `catalog` MCP tool, or the YAML files in `oodlc/`. Find the outcomes your task touches.
2. **New behavior? Propose before you build.** Draft outcomes for what someone outside the system will experience, and `propose` them (MCP tool, or `npx --no-install oodle propose draft.yaml`). They run and report from then on but block nothing, so you can build towards them. For a brief or PRD, use the `draft` MCP prompt or `npx --no-install oodle draft brief.md`.
3. **Iterate on one slice**: `run` with `only: ["checkout.*"]` (or `npx --no-install oodle run --only "checkout.*" --json`). Use `explain <id>` to see exactly what the app returned and emitted under each condition.
4. **Check before you finish**: `check` (or `npx --no-install oodle check --json`), then do what `what_to_do` says. The Stop hook runs this too and keeps you working while an outcome you broke is still broken.
5. **In the PR**, paste the outcome diff and give one line per behavior change: intended, or a side effect you didn't mean.

## Write fewer, better tests

- **Prefer an outcome to a unit test.** Outcomes test the boundary (status, body, effects), so refactors don't break them. Write unit tests only for pure logic with a large input space, and make those property tests.
- **Variants are conditions, not new tests.** A slow provider, a returning customer and a declined card belong in `conditions`, with `when` saying what that condition changes:
  ```yaml
  conditions: [first_purchase, payment_provider_slow, security.no-credentials]
  when:
    security.no-credentials: { status: 401, effects: [{ kind: payment.capture, count: 0 }] }
  ```
- **Measure, don't guess**: `npx --no-install oodle mutate --files "src/checkout.ts" --only "checkout.*"` plants small bugs. A *survived* mutant is a bug no outcome catches: tighten an expectation or add a condition, then propose it. *Only noticed* means a reviewer reading the diff would have to spot it.
- **Delete what adds nothing**: `npx --no-install oodle mutate --tests "npm test"` lists tests that catch nothing the catalog doesn't already catch (*candidates to delete*), and tests worth keeping (or turning into an outcome). Scaffolding tests you wrote while debugging go before the PR.

## Security

- External calls go through `ctx.effects` only. The simulation is sealed: a direct `fetch`, socket or SDK call to the network is a blocking `oodle.sealed` violation.
- Use the built-in conditions on outcomes that take input: `security.no-credentials`, `security.injection`, `security.oversize`, `security.extra-fields` (mass assignment and `__proto__` pollution), `security.replayed`. Say what should happen under each with `when`.
- Propose **constraints** for invariants: they hold on every run, including routes nothing describes. For example:
  ```yaml
  constraints:
    - id: no-side-effects-without-credentials
      statement: A request without credentials never causes an external effect
      check: "!!(request.headers && request.headers.authorization) || effects.every(e => e.boundary === 'internal')"
  ```
  Suggest `probe: { conditions: [security.no-credentials, security.injection] }` in `oodlc/config.yaml` so new routes meet the pack too. That is a config change for a person to approve.

## Never

- Never edit, remove or loosen an approved outcome, constraint or intent to make something pass. Never add `status: proposed` to an approved entry (it would stop it blocking), and never delete one to approve your own proposal. The pre-tool-use hook asks the person before any of these.
- Never set `sealed: false`, or add hosts to `sealed.allow`, to get past a violation. Route the call through `ctx.effects`.
- If an outcome really is wrong, stop and say so, with the change you would make. A person decides.
