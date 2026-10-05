# 0004. Conditions can carry their own expectations, and Oodle ships a security pack

- **Status:** Proposed
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0002. Constraints hold on every run](0002-constraints-hold-on-every-run.md)

## Context

A condition layered `given` (state, stubs, body) over an outcome, and the outcome's single `expect` had to hold under every condition. That works for variants where the promise stays the same, like a slow provider or a returning customer. It doesn't work for the variants that matter most for security: without credentials, checkout must answer 401 and charge nothing. The only way to say that was a separate outcome repeating the trigger. The example catalog already does this for a declined card and a provider outage.

Hostile variants also couldn't be expressed at all. A request had no headers, so "no credentials" couldn't be simulated. Nothing could send a request twice, and nothing could rewrite a body into an attack. Constraints saw `effects`, `state` and `response`, but not the request, so "no external effect without credentials" couldn't be written either.

Coding agents add routes quickly. ADR 0002 made every constraint hold on unknown-route probes, but a probe sent an empty body and nothing else, so a new route was never tested with hostile input.

## Decision

1. **`when` on an outcome.** It maps a condition id from the outcome's `conditions` to an `expect`. Under that condition, each field it names (`status`, `body`, `effects`, `latency_ms_max`) replaces the same field of `expect`. Fields are replaced whole, not merged, so "401 and no charge" never inherits a success body. A `when` key that isn't in `conditions` is a lint error. `when` is part of the outcome's definition, so editing it is `redefined` and blocks.
2. **`status` accepts a matcher**, e.g. `{ gte: 400, lte: 499 }`, for promises like "refused, one way or another".
3. **`given` gains `headers`, `repeat` and `fuzz`.** `headers` are request headers: a null value drops one, and `headers: null` sends none. `repeat: n` sends the same request n times against the same state; the last response is observed and effects accumulate. `fuzz` rewrites the body: `injection`, `oversize` or `extra-fields`.
4. **Constraints also see `request`**: `{ method, path, headers, body }` as sent.
5. **Built-in `security.*` conditions**, needing no knowledge of the app: `security.no-credentials`, `security.injection`, `security.oversize`, `security.extra-fields` and `security.replayed`. A catalog condition with the same id replaces the built-in one. Using one is opt-in: reference it from an outcome, or list it under `probe.conditions`.
6. **`probe.conditions` in `oodlc/config.yaml`.** Unknown routes are probed once by default and once more under each listed condition, and every constraint is checked on every probe. A violation blocks, as in 0002, labelled with the condition.
7. **`oodle.prototype-pollution` is a built-in constraint.** `security.extra-fields` sends an own `__proto__` key. If the app merges it into `Object.prototype`, the run is a violation. It is checked on every run.

## Options considered

### A. Keep one `expect`, and write a separate outcome per hostile variant

- Good: nothing new to learn.
- Bad: the trigger and body are repeated per variant, and the variants drift apart. A security matrix across N outcomes becomes N×5 outcomes nobody maintains.

### B. Expectations on the condition itself

- Good: write it once, apply it everywhere.
- Bad: what "no credentials" should return depends on the outcome. A public health check answers 200 and checkout answers 401. The promise belongs to the outcome.

### C. `when` on the outcome, replacing fields whole (chosen)

- Good: the promise stays with the outcome, and the condition stays a reusable recipe for the world.
- Good: replacing fields whole has one obvious reading.
- Bad: `when` must repeat what it keeps of a replaced field. That's acceptable, since overrides are short in practice.

### D. Apply the security pack to every outcome automatically

- Good: no opt-in to forget.
- Bad: most outcomes would need a `when` for each condition on day one or start failing, which turns a safety feature into a migration. Probing unknown routes with the pack (`probe.conditions`) gets most of the benefit with no `when` needed, because only constraints are checked there.

## Consequences

- One outcome can hold its success path and its hostile variants, and an agent can add a variant by adding a condition id and a `when` entry.
- New routes added by an agent meet the security pack through `probe.conditions` and are judged by constraints such as "no external effect without credentials".
- Request headers are now part of the app contract's `Request`, which apps could already read.
- The fuzz payloads are generic. They find mass assignment, prototype pollution, replay and missing-auth bugs reliably. Injection is only caught if a constraint or expectation notices its effect, since Oodle has no database to inject into.

## Revisit if

- Teams want `when` to merge `body` matchers instead of replacing them.
- A fuzz variant needs app knowledge (another tenant's credentials). Today that's a catalog condition with `headers`, and the pack could grow a documented recipe for it.
