# 0006. Agents propose, humans approve: `status: proposed` and propose-only writes

- **Status:** Proposed
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Revisits:** [0001. Outcomes are declared, behaviors are observed](0001-outcomes-and-behaviors.md) ("Revisit if teams want outcomes that are tracked but not yet enforced")

## Context

Oodle's rule is that only what a human declared can block. With coding agents in the loop, two things strain it.

1. **Agents need to build toward outcomes that don't hold yet.** An agent implementing a feature should write down what the customer will experience first, then make it true. But an outcome in the catalog blocks the moment it exists. So the agent either writes code first and the outcome after (tests written to match the code), or adds a failing outcome that blocks every run.
2. **Agents write files.** Nothing distinguished an agent adding a new outcome from an agent loosening an existing one to get green. Both are YAML edits. `oodle check` catches the second as `redefined`, but only at merge time, and only if someone reads it.

The drafter (from a brief to a catalog) and the MCP server, both on the roadmap, make this concrete: each writes catalog entries on someone's behalf.

## Decision

1. **`status: proposed`** may be set on intents, outcomes and constraints. A proposed entry is fully part of the catalog, and it runs:
   - A proposed outcome runs under its conditions. Unmet expectations are reported ("not yet") and **never block**.
   - A proposed constraint is checked on every run. Breaches are **notices**, reported and never blocking.
   - Constraint violations seen while running a proposed outcome still block. Approved constraints hold on every run (0002).
2. **Approving means deleting `status: proposed`.** In the outcome diff, an approved proposal becomes a `new` outcome: it doesn't block if it holds and blocks if it doesn't. An approved constraint is `new`.
3. **Marking an approved entry as proposed is a redefinition**, and blocks. A proposal can never be used to silence an outcome. Withdrawing a proposal (deleting it) changes nothing that was approved, and doesn't block.
4. **An approved outcome can't trace to a proposed intent** (lint error).
5. **Agents write through propose-only paths.** `oodle propose` (and the MCP `propose` tool) adds entries to `oodlc/proposed.yaml`, forces `status: proposed` on intents, outcomes and constraints, and refuses any id that already exists. A proposal that would break the catalog or add lint errors is rolled back. There is no agent-facing tool that edits or removes an approved entry.
6. **The agent integration guards hand edits.** The Claude Code pre-tool-use hook asks the person before any edit that changes, removes, approves or silences an approved outcome, constraint or intent, and before changes to `sealed` and `probe` in the config. `OODLE_HOOK_STRICT=1` turns asking into refusing.

## Options considered

### A. Proposals in a separate folder the runner ignores

- Good: nothing in the catalog changes meaning.
- Bad: the agent can't run what it proposed, so it can't build toward it, which was the point.

### B. Proposals that run but are excluded from `oodle check`

- Good: nothing new in the diff.
- Bad: a reviewer can't see what the agent proposed, or how close it is to holding.

### C. `status: proposed`, run and reported, never blocking (chosen)

- Good: the agent writes the promise first and works until it holds. The reviewer sees each proposal and its state in the diff. Approval is one deleted line, visible in review.
- Good: one field, applied the same way to intents, outcomes and constraints.
- Bad: a catalog can collect stale proposals. Lint warns about each one.

### D. Trust the agent's edits and rely on `redefined` at merge time

- Good: no new concept.
- Bad: it puts the whole burden on a reviewer reading YAML diffs, while the agent has already spent its effort on the wrong target.

## Consequences

- An agent can start a feature by proposing its outcomes, building against them with `oodle run`, and stopping when they hold. A person then approves them in review.
- The drafter is a prompt, not a model call: `oodle draft brief.md` writes it, and any agent turns it into YAML for `oodle propose`. With `oodle mcp`, the agent gets the same prompt and the propose tool.
- Run JSON gains `summary.proposed` and `summary.proposed_constraint_notices`, observations gain `notices` and `proposed`, and the outcome diff gains the `proposed` status.

## Revisit if

- Proposals need an owner or an expiry ("proposed by X, until Y").
- Teams want an agent's proposals to block their own branch but not others (proposal strength per branch).
