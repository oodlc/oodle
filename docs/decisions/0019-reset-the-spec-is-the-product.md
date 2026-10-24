# 0019. Reset: people manage the spec, code is generated and checked against it

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Supersedes, once accepted:** 0001 to 0018, as a set. They describe v0 and stay readable at tag `v0-archive`.

## Context

Oodle v0 guards code that people and agents write. It protects declared outcomes in a sealed simulation and reports an outcome diff on each pull request. To get there from existing services it grew: actors, capabilities, experiences, unknowns, terms, changes, evidence grades, behaviors, conditions, boundaries, approvals, stubs from traffic, mutation testing, and adapters for Express, Fastify, Koa, Hono, Next.js and Workers. That makes about 25 concepts before someone writes their first promise.

The direction now is different: people manage intent, personas, what the app holds, journeys and constraints, and code is generated from them. Against that direction:

- Most of v0's concepts exist because code is primary and already there (`discover`, behaviors, evidence grades, change files that come before a separate code pull request). They don't apply when code is generated from the spec.
- v0's spec is made of outcomes, and an outcome-only spec says far less than code. Two builds from the same outcomes give two different apps, and regenerating moves things nobody changed. v0 has nothing that addresses this, and it is the main problem the new direction has to solve.
- Oodle has no users, so a reset costs no one a migration.
- The engine underneath (a sealed, deterministic simulation with real databases in process, and a differ) is what the new direction needs most, and it works.

## Decision

1. **v0 is archived as tag `v0-archive`** (the same commit as `v0.19.0`, the tip of `main` on 2026-10-23). Nothing is deleted from history.
2. **The direction is [VISION.md](../../VISION.md)**: a spec of six kinds of entry (intent, personas, domain, journeys, constraints, decisions), in two tiers. People write the declared tier and only people change it. The generator writes the decided tier where the spec is silent, and the next build must keep what it decided.
3. **Under-specification is measured, not argued.** Two independent builds from the same spec run in the same simulation and are diffed. Each difference a user could see becomes a question, until the builds agree.
4. **Merge the intent, not the code.** Every change is an intent (what should change, why, what has to stay true and what it rules out, how we'll know it worked), approved and merged before any code exists. The gaps check runs on the intent before it is approved. Once it merges, the build ships if the checks that come from it pass. No person reads the code diff to let it ship. This takes v0's change files (0012) from one feature to the way every change happens.
5. **The stack and non-functional requirements are constraints**, each saying whether it is checked on every build, checked in production (reported only), or only given to the generator.
6. **The tree is rebuilt from one thin slice**: interview, build, verify and gaps for one example app, on one stack (Hono on Cloudflare Workers with D1). Code is ported from the archive only when the slice needs it.
7. **Until that slice works, this branch changes no code.** VISION.md and this record are the whole change. Clearing the old tree is a separate pull request, after this one is accepted.

## Options considered

### A. Keep v0 and add a greenfield path on top (an interview from nothing, an API sketch, a build brief)

- Good: everything built so far keeps working.
- Bad: adds concepts to a model already too big to explain, and still leaves the spec outcome-only, so builds still drift.

### B. Simplify v0 in place: rename, fold and hide concepts

- Good: less churn, and the engine stays where it is.
- Bad: the model is still about guarding code someone else wrote. Under-specification needs a second tier and a gaps check, which a rename doesn't give.

### C. Reset around the spec, keeping the engine in the archive to port from (chosen)

- Good: one model, built for code nobody has to read, with the main problem (under-specification) at its centre.
- Good: no users to migrate, and nothing lost: the archive and its 18 decision records stay in history.
- Bad: v0's working features (adapters for existing services, discovery, mutation testing) are gone from the tree until something needs them again.
- Bad: the hard parts are unproven: checking journeys on screen, capturing decisions at the right grain, and the cost of building twice.

## Consequences

- The README points to VISION.md until the new tree replaces it.
- When the first release of the new line ships, the 0.x versions of `@oodlc/oodle` on npm are deprecated with a message pointing to it. The GitHub Action's `v0` tag stays on 0.19.0.
- Decision records restart from this one. Records 0001 to 0018 are marked Superseded by 0019 when this is accepted.

## Revisit if

- Two builds from a reasonable spec can't be made to agree without the spec turning into code written in YAML. That would mean the decided tier is the wrong answer to under-specification.
- Journeys can't be checked on screen in a sealed, deterministic way. That is the main thing people see in a web app.
- Something serious (a security hole, a data loss) gets past the checks from an intent, and nothing short of a person reading code would have caught it.
- Someone wants v0 for an existing service. The archive is there to fork.
