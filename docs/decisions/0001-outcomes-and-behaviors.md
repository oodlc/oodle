# 0001. Outcomes are declared, behaviors are observed

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

The first version of the catalog had one kind of entry, a "behavior", with two flags: `durability` (durable or incidental) and `provenance` (declared, observed or inferred). Together they produced six combinations, and only some of them made sense. An "observed, durable" behavior, for example, would mean something the runner noticed had become binding without anyone approving it.

The two flags were standing in for one real distinction: **who vouches for this?** If a human declared it and approved it, it should be protected. If the runner only saw the system do it, it describes the current code and nothing more. Agents should be free to change it.

The framework's name also changed to OODLC, the Open Outcome Delivery Lifecycle, which put the word "outcome" at the centre.

## Decision

The catalog has three layers, and the layer determines durability. Nothing else does.

| Layer | Who writes it | Durable? | Example |
| --- | --- | --- | --- |
| Intent | Human | Yes | Customers can buy without surprises |
| Outcome | Declared, human-approved | Yes, by definition | Paying shows a confirmation and sends one receipt |
| Behavior | Observed by the runner | No, by default | Checkout emits `internal.audit` |

Concretely:

- **Outcomes** live under `outcomes:`, must link to an intent (a lint error otherwise), and have an `expect`. Every change to an outcome blocks until a human approves it: broken, failing, changed, redefined, removed, or a new outcome that fails.
- **Behaviors** live under `behaviors:` and may carry an `observed` snapshot. A mismatch is drift: it is reported but never blocks. Internal effects seen during an outcome's run (`internal.*`) are behavior too.
- **Unknown routes** (described by nothing) are probed in simulation and come back as a proposed **behavior**, never as a proposed outcome. Only a human makes something durable.
- **Promotion** means moving an entry from `behaviors` to `outcomes`, adding an intent, and turning `observed` into `expect`. It does not block. **Demotion** removes an outcome, so it does block. An id cannot be both an outcome and a behavior at the same time.
- A behavior on any boundary other than `internal` gets a lint warning asking for a promotion decision.
- The `durability` and `provenance` fields are gone.

## Options considered

### A. Keep one entry type with `durability` and `provenance` flags

- Good: no migration.
- Bad: invalid combinations are representable, and lint has to police them.
- Bad: "durable" was a field anyone could flip in a YAML edit. Under the new model, making something durable means moving it into `outcomes` and giving it an intent, which is visible in review.

### B. Outcomes only; drop behaviors from the catalog

- Good: smallest model.
- Bad: no place to record "we saw this, we looked, it's fine." Every undescribed route would come back as unknown on every run, forever.

### C. Outcomes and behaviors as separate layers (chosen)

- Good: durability follows from authorship, so it cannot be set by accident.
- Good: it matches how the framework talks: you deliver outcomes, and the system happens to behave in some way.
- Good: promotion and demotion are explicit, reviewable moves.
- Bad: it breaks v0 catalogs: `behaviors:` becomes `outcomes:`, and the two flags must be deleted. Acceptable before any public release.

## Consequences

- The diff is an **outcome diff**. Behavior changes appear in a separate "report only" section.
- Incidental entries from the old model, such as `ops.health`, become behaviors.
- `Observation` and `Gap` carry a `kind` so the runner can treat outcome and behavior runs differently.
- The blocking rule is stated once, in [0002](0002-constraints-hold-on-every-run.md): only what a human declared can block.

## Revisit if

- Teams want outcomes that are tracked but not yet enforced (for example while an agent is still building toward them). A `status: proposed` on outcomes would be the likely shape, rather than bringing back a durability flag.
- Behaviors start needing ownership or expiry (for example "acknowledged by X until date Y").
