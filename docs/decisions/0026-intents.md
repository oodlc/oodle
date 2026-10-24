# 0026. Intents: structured changes, approvals bound to content, merged-only checks

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

Every change after the first build is an intent, agreed before any code exists. VISION.md and the guide fix the shape (changes, why, keeps, rules out, done when) and the rule that only merged intents count. They leave open which changes an intent can express, what makes an approval stale, how long an intent's checks apply, and how "rules out" is checked.

## Decision

1. **Changes are ten structured operations** on the declared tier:
   - rules: `replace_rule`, `add_rule`, `remove_rule`;
   - constraints: `add_constraint`, `remove_constraint`, `replace_constraint`;
   - journeys: `add_journey`, `add_step`, `replace_step`;
   - personas: `add_persona_capability`.

   They are checked in memory before anything is written. Merging writes only the lines they name, with a comment saying which intent and who approved it.
2. **An approval binds to the intent's content hash**: everything but status, approvals and merge bookkeeping. Editing the intent makes earlier approvals stale; `merge` refuses a stale approval.
3. **Review** applies the changes to a scratch copy of the spec, compiles it, builds it twice (or takes two builds), and diffs only the scenarios the change reaches: changed or new journeys, and scenarios that act on the entities the change names. The gaps go into the project with `intent_id`. An intent with open gaps can't be approved, here or in the inbox.
4. **Only merged intents count.** Their checks come from the base ref (`intents.base`, default `main`) read through git. An intent in the working tree, or only on the branch being built, adds nothing.
5. **An intent's extra checks apply until a build passes after it merged.** `done_when` and `keeps` journeys must exist and pass. `rules_out` is checked like this:
   - **new dependencies:** any beyond `hono` and `@oodle/runtime`;
   - **new outbound hosts:** any the last passing build didn't call;
   - **new routes:** top-level route segments the last passing build didn't declare.

   What they rule out is also written into the generator's AGENTS.md.

## Consequences

- Changing a domain rule changes the hash every journey and check compiles against, so a merge recompiles them. That costs a model call per journey and check, and gives the model the new rule to read old constraints against.
- The cancel-fee example in the guide keeps "An owner is never charged for a walk that didn't happen" while charging for late cancellations. The two can only both hold if a late cancellation counts as a walk that happened. The compiled check has to be read against the new rule, which is why it recompiles.

## Revisit if

- People need changes the ten operations can't express. Add operations, or allow a free-text change a person confirms.
- "Applies until a build passes" proves too short for `rules_out`. Keep it for N builds, or until the next intent.
