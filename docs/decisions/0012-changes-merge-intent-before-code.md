# 0012. Changes: the intent merges before the code

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Builds on:** [0007. Approvals in CI](0007-approvals-in-ci.md), [0010. The inventory](0010-capabilities-and-the-inventory.md)

## Context

Oodle is reactive. The code pull request comes first, the outcome diff second, and approval third: a reviewer reads `changed` or `redefined` on a pull request an agent already wrote, and approves or rejects work that is done. Nothing in the catalog says what a change is meant to do before the code exists. So the argument about intent happens late, on a diff, and an agent has no agreed target beyond "make check pass", which approving the result also satisfies.

Most of what is needed exists already: outcomes say what must hold, capabilities say what a change may reach (0010), the sealed simulation records every effect, and the outcome diff knows what moved.

## Decision

1. **A change is a file in `oodlc/changes/`**: an `id`, `because` (why, in words a reviewer can argue with), `reaches` (the capabilities it may touch), `amends` (per outcome: a new `statement`, `expect` or `when`, or `remove`; per constraint: a new `check`, or `remove`), and `rules_out` (`new effects`, `new hosts`, `new routes`, `new dependencies`). Changes never run and never block on their own.
2. **Intent pull request first.** It holds only the change file. People argue and approve there, with their own review rules (CODEOWNERS on `oodlc/changes/`). Oodle lists it under "Proposed changes".
3. **Only merged changes count.** `oodle check` reads changes from the base. A pull request that adds a change file can't use it, so no pull request approves itself.
4. **A merged change covers exactly what it says.** In a code pull request:
   - an outcome that `changed` is covered when its new output meets the amended expectation, under every condition it runs;
   - an outcome that is `redefined` is covered when its new definition is the base definition with the amendment applied, which is what `oodle changes fold` writes;
   - a `removed` outcome or constraint is covered when the change removes it, and a constraint is covered when its new check is the amended one;
   - a covered item stops blocking and names its change. A `broken` or `failing` outcome is never covered.
5. **Using a change binds the pull request to its scope.** If any item is covered by a change, then every outcome, behavior or new route that moved outside its `reaches` blocks as **outside intent**. Without `reaches`, only what it amends may move. Each `rules_out` item is checked from what Oodle already records:
   - new effects: effect kinds the base never produced, other than ones the amendments expect;
   - new hosts: effects from a service the base never called, and new `sealed.allow` hosts;
   - new routes: routes the base didn't have;
   - new dependencies: names added to `package.json`.

   A pull request that uses no change is checked as before.
6. **The comment cites the intent**: the change, why, and the commit that merged it.
7. **After it ships, the change folds in.** `oodle changes fold <id>` writes the amendments into the catalog, in place, and moves the change to `oodlc/changes/archive/`. In that pull request the change is still on the base, so its redefinitions are covered.
8. **The brief and the checks are one source.** `oodle changes brief <id>` (and the MCP `change` prompt) gives a coding agent the why, the scope, what must hold after, and what is ruled out, from the same file `oodle check` enforces.

## Options considered

### A. Keep approving after the code (today)

- Good: nothing new.
- Bad: the intent is argued on finished work, and an agent's target is whatever gets approved.

### B. Amend the catalog directly in an intent pull request

- Good: one kind of file.
- Bad: an amended outcome fails until the code lands, so the intent pull request either blocks or has to mark the outcome proposed, which is a redefinition (0006). And there is no place for scope or what is ruled out.

### C. Change files, merged first, covering only what they say, binding scope (chosen)

- Good: the argument happens before the work; a pull request that does what was agreed passes with no further approval; anything else still blocks.
- Good: built on what Oodle already records, so `rules_out` costs almost nothing.
- Bad: two pull requests per change. A small change can still go the old way, approved in the code pull request.

## Consequences

- `oodle check`, the PR comment and its JSON gain `changes`: what a pull request carries out, what moved outside intent (blocking), and changes it proposes. Outcomes and constraints gain `covered_by`.
- The Stop hook sends "outside intent" and "not yet what the change says" back to the agent. Only what a change doesn't cover goes to a person.
- `oodle changes` lists, briefs and folds. Lint checks that a change reaches and amends what exists.

## Revisit if

- Teams want to name the change a pull request carries out, instead of Oodle inferring it from what it covers.
- A change needs to add outcomes, not only amend them (today a new outcome that holds doesn't block anyway).
- "No new dependencies" needs to see transitive dependencies (a lockfile), not only `package.json`.
