# 0021. The simulation: Miniflare instances reset between scenarios, controlled through sim-only routes

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

The implementation guide asks for each build's Worker to run in Miniflare, sealed, with the clock, ids, randomness, mail and outbound requests controlled by the harness. It sketches one Miniflare instance per (build, scenario), a control binding for the clock, and the driver types in `@oodle/sim/driver`. Two runs of the same build must give byte-identical observations.

Building it showed that starting workerd takes a few hundred milliseconds, and an exploration plan runs up to 200 scenarios per build, twice per gaps run. It also showed that the harness has no way to reach module state inside the Worker except over HTTP.

## Decision

1. **A few instances per build, reset between scenarios.** Scenarios are spread over up to four Miniflare instances. Before each scenario, the harness drops every table (newest first, so foreign keys hold), applies the build's migrations, and resets the runtime's clock, id counters, PRNG and outbox. This gives the same starting state as a fresh instance for a fraction of the cost.
2. **The harness controls the runtime through routes under `/__oodle/`** (`reset`, `clock`, `users`, `login`, `outbox`), served by the runtime's `oodle()` middleware only when `OODLE_MODE=sim`. In production they are 404. This replaces the guide's "control binding".
3. **The runtime owns persona users.** A `users` table (id, persona, name, email, data as JSON) comes with the template's first migration. The harness seeds it from scenario fixtures (`owner:ada` is user `ada`, persona `owner`), and `rt(c).user()` is the signed-in user.
4. **The driver contract lives in `@oodle/runtime`** (`import type { Driver } from '@oodle/runtime'`), not `@oodle/sim/driver`. A generated app already depends on the runtime and never on the simulation.
5. **What a step observes.** After an action, the harness reads the screen the action landed on. An action that doesn't name a screen (a refused form post, say) is observed on the last response the user got, because that page is what the user sees. A step with `look` reads a named screen, possibly as another persona.
6. **Hono and `@oodle/runtime` resolve to Oodle's own copies** when a build is bundled, so every build runs on the same versions and needs no install to be simulated.
7. **Requests that go around the runtime** land in Miniflare's outbound service. They get a canned `200 {}` and are reported as escapes for the scenario.
8. **A compatibility date newer than the bundled workerd supports** runs at the newest date it does support, instead of failing to start.

## Options considered

### A. One Miniflare instance per scenario (the guide's sketch)

- Good: nothing can leak between scenarios.
- Bad: 400 workerd startups per gaps run.

### B. A pool of instances, reset between scenarios (chosen)

- Good: fast, and the tests check that two runs, in different pool sizes, give byte-identical observations.
- Bad: state the runtime doesn't know about (a module-level cache in generated code) could leak between scenarios. The determinism check and the generator's rules (all state in D1) are what prevent it.

## Consequences

- `oodle verify` must check that the build uses `oodle()`. Without it the harness can't reset or sign in, and the run fails with a message that says so.
- Generated code must keep its state in D1, not in module variables. This goes in the generator's rules.

## Revisit if

- A build passes alone and fails in a pool, or the other way round: state is leaking between scenarios.
- Screens need a real browser (Playwright). The `ViewModel` stays; how it is read changes.
