# 0010. The inventory explains the system: capabilities, actors, experiences and unknowns

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Revises:** [0001. Outcomes are declared, behaviors are observed](0001-outcomes-and-behaviors.md) (an outcome no longer needs an intent if it traces to a confirmed capability)

## Context

Oodle protects what a person has put into words, but nothing in it helps that person find the words. Teams adopting it on an existing service get stuck before the first outcome:

- `oodle propose --routes` writes each undescribed route as an outcome whose statement is `TODO: say what a caller can count on`, traced to whatever intent comes first.
- `oodle draft` needs a brief. Most existing services have none, or one that is out of date.
- What `init` discovers is shaped like the code (routes, outbound hosts, tables), not like the product: nothing says who uses a route, or which routes together let someone do one thing.
- Lint warns that an intent has no outcomes, but can't say whether the system can do it at all. In `examples/checkout`, `customers-track-orders` has no route serving it.

Teams also want different depths. Some only want to describe their system; others want every promise guarded. Today the only way in is an intent plus an outcome.

## Decision

1. **The catalog gains an inventory: four optional sections that explain the system and never block.** Any catalog file may hold them, as with the existing five (0003).
   - `actors`: who uses the system (`id`, `statement`).
   - `capabilities`: what the system lets an actor do, said as "<actor> can <verb> <object>", with the `surfaces` (`METHOD /path`) that reach it, an optional `actor`, `intent` and free-text `evidence`.
   - `experiences`: what an actor goes through across capabilities (`steps`), and what would make it feel broken (`feels_broken_when`). Each of those is a candidate condition or constraint.
   - `unknowns`: a `question` the system can't answer about itself, who can (`ask`), what it is `about`, and once someone has said, their `answer`. An answered question is no longer open.
2. **Inferred means proposed.** Actors, capabilities and experiences take `status: proposed` exactly as in 0006. Discovery and agents write them as proposals; a person confirms one by deleting the line. Unknowns have no status: they are questions. A person answers one by recording an `answer`, or by folding it into the catalog and deleting it.
3. **An outcome traces to something a person confirmed: an intent, a confirmed capability, or both.** This revises 0001, which required an intent. The reason in 0001 stands: a promise that blocks merges must be justified by something a person vouched for. A confirmed capability is that. An approved outcome that traces only to a proposed capability is a lint error, as tracing to a proposed intent already is.
4. **Outcomes and behaviors may name their `capability`.** Coverage is computed from this field, never kept by hand in the capability. One that names none belongs to the capability whose surfaces reach its trigger, so coverage shows before anyone links them.
5. **Every rung is optional, and none requires the one above it.** A catalog of capabilities alone is valid: Oodle explains it and nothing blocks. Each rung added unlocks more: outcomes add protection, intents add the why and show what isn't built, experiences add journeys. Catalogs without an inventory keep working unchanged.
6. **Lint reports the inventory, and only its references can be errors.** An unknown actor, intent or capability is an error. A confirmed capability with no outcome, a proposed entry, an open question, and a capability statement that says nothing (`TODO`, or verbs such as handles, manages, processes, supports) are warnings.
7. **Confirming a capability is a person's call.** The Claude Code hook guards capabilities as it guards intents, outcomes and constraints, because a confirmed capability can now justify an outcome. Actors and experiences justify nothing yet, so they are not guarded.
8. **The words come from people; agents may ask and draft.** `oodle interview` confirms a capability only with someone at a terminal; answers piped in never confirm. The MCP `answer` tool fills in proposed capabilities and answers questions for a person, but never confirms, never edits a confirmed capability, and anything new it adds (an actor, an intent) is a proposal.

## Options considered

### A. Keep the inventory outside the catalog (a separate file or tool)

- Good: the catalog's meaning doesn't change.
- Bad: outcomes can't point at capabilities, so coverage can't be computed, and the two drift apart.

### B. Require the full ladder: intent, capability, outcome

- Good: one shape, complete traceability.
- Bad: raises the bar for the teams who are stuck today. The point is to let them start lower.

### C. A separate `grade: inferred | confirmed` field

- Good: reads naturally for discovered entries.
- Bad: a second way to say "not yet approved by a person", next to `status: proposed`, with the same rules. One field is enough.

### D. Optional inventory sections, proposals for what is inferred, outcomes traced to an intent or a confirmed capability (chosen)

- Good: a team can start from capabilities or from outcomes; nothing that works today changes.
- Good: reuses 0006's proposal mechanics, propose-only writes and hook.
- Bad: two ways for an outcome to be justified. Lint states which one it found.

## Consequences

- `spec/catalog.schema.json` gains four sections and a `capability` field on outcomes and behaviors. oodlc.com serves the schema from the repository, so editors see the new sections once this merges.
- `oodle propose` and the MCP `propose` tool accept the new sections and force `status: proposed` on actors, capabilities and experiences. The MCP `catalog` tool lists them, and the drafter asks for capabilities and experiences.
- Nothing in the inventory changes what blocks: the outcome diff ignores it. Linking an existing outcome to a capability doesn't redefine it, just as changing its intent doesn't.
- Discovery (`oodle discover`), the interview, `explain --system` and per-capability coverage build on this. Evidence is free text until discovery gives it a shape.

## Revisit if

- Teams want a confirmed capability with no outcome to block (an opt-in "every capability is protected" rule).
- Evidence needs grades or sources Oodle can check, rather than free text.
- Experiences need to run as sequences of requests, which would make them a new kind of trigger.
