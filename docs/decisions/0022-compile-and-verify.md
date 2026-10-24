# 0022. Compile and verify: a derived vocabulary, four kinds of check, one model client

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

The implementation guide asks for journeys, constraints and pinned decisions to be compiled once, by a model, into things the simulation can run and check, and cached. It leaves open how actions get their ids, what a compiled constraint looks like, which parts need a model at all, and where `verify` lives.

## Decision

1. **The vocabulary is derived, not compiled.** Each capability phrase is an action: the persona, the verb, then the object with filler words dropped and plurals of entities made singular (`cancel their own walks` is `owner.cancel_walk`). `X or Y things` is two actions. Every app has the screens `home`, `<entities>` (the list) and `<entity>` (one, by id). No model is involved, so the vocabulary never drifts between compiles. An action's inputs are the entity it acts on, plus whatever compiled journeys pass to it.
2. **Four kinds of check.** A constraint checked on every build, or a pinned decision, compiles to one of:
   - `scenario`: a short scenario whose expectations must hold;
   - `never_shows_field`: a fixture field some personas must never see for others;
   - `never_matches`: a pattern no screen may match;
   - `unchecked`: with the model's reason.

   Checks are data, not generated code, so a person can read `oodle/compiled/checks/` and the checks can't do anything but check. `unchecked` is a warning in `verify` and listed by `oodle status`.
3. **Constraint classification uses words first.** Percentiles, error rates and latency are `production`. "Runs on…", retention and residency are for the `generator`. A model classifies only the rest. The result is written back to the spec, where a person can correct it.
4. **The exploration plan is derived too.** It takes its sample inputs (who books whom, when) from compiled journeys. Its scenarios come in this priority: collections, permissions, states, rule boundaries, field edges. It stops at the cap.
5. **One model client.** Everything that asks a model (compile, gap questions, tier classification, `answer --auto`, the decision judge) goes through `Model.json(label, system, prompt, zod schema)`. By default that is the Claude Agent SDK with every tool off and structured output, using Claude Code's own credentials. A scripted model replays recorded answers in tests. Every compiled file says which model compiled it (`by`).
6. **The example's compiled files come from recorded answers** (`packages/compile/test/dogwalk-answers.ts`), marked `by: recorded`. They were written in the session that built the slice, so the repository's tests need no model. Compiling with a real model is the opt-in end-to-end path.
7. **`@oodle/verify` is its own package**, because both the CLI and the generator's post-build guard call it. This is a package the guide's layout doesn't list.
8. **`oodle compile --check`** changes nothing. It shows each journey line next to the steps it compiled to, lists what is stale, and exits 1 when anything is.
9. **The build's own typecheck runs when it has `node_modules`.** Without them, verify skips it with a warning; fixtures in this repository have none.

## Options considered

### A. Compile constraints and decisions into code (a predicate over observations)

- Good: can express anything.
- Bad: generated code that decides whether a build ships is the code nobody reads, one level up. Hard to show a person.

### B. A few declarative kinds, with `scenario` as the general one (chosen)

- Good: readable, can't have side effects, and `scenario` covers most decisions (orders, formats, wording, refusals).
- Bad: some constraints won't fit and stay `unchecked` until a kind is added.

## Consequences

- The generator implements exactly `compiled/actions.json`; `verify` blocks a driver that misses any action or screen.
- A phrase the rules derive badly (`rate a walker` names no entity, so it gets no inputs) is visible in `actions.json`. The fix is better words in the spec.

## Revisit if

- Many constraints or decisions stay `unchecked`: add a kind for what they have in common.
- Derived action ids keep surprising people: compile the vocabulary with a model, but keep it cached and committed.
