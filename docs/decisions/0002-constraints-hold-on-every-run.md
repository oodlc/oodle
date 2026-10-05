# 0002. Constraints hold on every run

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0001. Outcomes are declared, behaviors are observed](0001-outcomes-and-behaviors.md)

## Context

A constraint is an invariant a human writes down, such as "a payment is never captured without an order record." It is checked as a JS expression over the effects, state and response of a run.

[0001](0001-outcomes-and-behaviors.md) split the catalog into outcomes, which block, and behaviors, which never block. That left an open question: on which runs do constraints apply, and what happens when one fails?

Two facts about the code shaped the answer:

1. **Constraints were already global for outcomes.** The runner checked every constraint in the catalog on every outcome run. The `constraints:` list on an outcome had no effect. In practice the question was never "which constraints apply to this outcome", only "which runs do constraints cover".
2. **Probes of unknown routes skipped constraints entirely.** When an agent adds a route that nothing describes, the runner probes it and proposes a behavior. That probe never checked constraints.

The second fact is the dangerous one, and it is exactly the case OODLC exists for. Suppose an agent adds `POST /quick-buy` that captures a payment without creating an order. It would have shown up as a curious "unknown route" with a 200, and nothing would have blocked.

## Decision

**Every constraint is checked on every run: outcome runs, behavior runs, and probes of unknown routes. Any violation blocks the merge.**

Supporting rules:

- **Violations are tracked separately from expectation failures.** `Observation.failures` holds unmet expectations; `Observation.violations` holds constraint breaches. On a behavior, a failure is drift and is reported only; a violation blocks.
- **Constraint checks fail closed.** If a check throws, that counts as a violation. A check that cannot run is not evidence that the invariant holds.
- **Changing a constraint needs approval.** Removing or editing a constraint blocks, like redefining or removing an outcome. Adding one does not.
- **Pre-existing violations still block**, consistent with how an outcome that was already failing on the base branch still blocks.
- **The `constraints:` list on an outcome stays, as traceability only.** It records which invariants an outcome relies on. The schema says so.

This turns the blocking rule into one sentence: **only what a human declared can block (outcomes and constraints); what the runner merely observed (behaviors) never blocks on its own.** A behavior run that breaches a constraint does not block because of the behavior. It blocks because a declared invariant was broken, and the behavior run is where Oodle saw it.

## Options considered

### A. Constraints on outcome runs only (the previous behavior)

- Good: simple, and no surprises for people writing behaviors.
- Bad: an invariant that holds only on paths someone has already described is not an invariant. It gives no protection on new routes, which is where agent-written code most often goes wrong.
- Bad: it leaves the per-outcome `constraints:` list looking meaningful when it is not.

### B. Constraints on every run, and every violation blocks (chosen)

- Good: it closes the unknown-route gap, which is the highest-risk path.
- Good: it matches what a constraint means to the person who wrote it.
- Good: the blocking rule follows from authorship (declared vs observed) rather than from the type of run, so it is easy to explain.
- Bad: a constraint written with one flow in mind can misfire on another, for example one that assumes `response.body.order_id` exists. Mitigation: constraints should be written over effects and state, and a misfiring constraint is a bug in the constraint that is worth surfacing.
- Bad: more runs mean more checks. They are in-process and cheap, so this is acceptable at v0 scale.

### C. Constraints on every run, but violations outside outcomes only reported

- Good: it gives visibility without the risk of false positives blocking merges.
- Bad: the unknown-route case would be reported, not stopped. A reported invariant breach in a PR comment is easy to miss, and agents do not read PR comments for meaning.
- Bad: "this invariant blocks, except when it doesn't" is a harder rule to explain than either A or B.

### D. Let each constraint declare its own scope (`applies_to: outcomes | all`)

- Good: maximum control.
- Bad: it adds a knob before anyone has needed it. Every catalog author would have to decide on a scope, and the safe answer is almost always "all".
- Not ruled out for later; see "Revisit if".

## Consequences

- A constraint violation now appears in three places: inside an outcome's details (as `broken`), in a "Constraint violations (blocking)" section for behaviors and unknown routes, and in `oodle run` output as ❌.
- `oodle run` exits 1 on any violation, not only on outcome failures.
- Changing or deleting a constraint shows up in a "Constraint changes" section and blocks until approved.
- **Known limit: probes are shallow.** An unknown route is probed once, with the default `given` and an empty body. A violation reachable only with particular input will not be found until someone describes that route as a behavior or an outcome with the right `given`. Constraints on every run make that coverage count, but they do not create coverage on their own.
- Tests in `test/scenarios.test.ts` pin this down: a violation on a behavior run blocks, a violation on an undescribed route blocks, a throwing check fails closed, and loosening a constraint needs approval.

## Revisit if

- Real catalogs show repeated false positives from constraints that are correct for one flow but meaningless for another. Option D (`applies_to`) is the likely answer then, defaulting to `all`.
- Pre-existing violations make adoption on existing codebases impractical. A baseline file of known violations, which blocks only on new ones, would be the next step. It should be a deliberate, visible opt-in rather than a silent default.
- Probing gets deeper (generated inputs, learned models). The shallow-probe limit above changes, and so might the cost argument.
