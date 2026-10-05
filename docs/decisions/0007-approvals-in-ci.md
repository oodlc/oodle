# 0007. A change to a promise is approved in the pull request, bound to exactly what changed

- **Status:** Proposed
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Revisits:** [0001. Outcomes are declared, behaviors are observed](0001-outcomes-and-behaviors.md) ("any change blocks the merge until a human approves")

## Context

Since 0001, every change to an outcome blocks the merge "until a human approves": `changed`, `redefined` and `removed` outcomes, and `redefined` or `removed` constraints. But nothing in Oodle let a human approve. In a pull request, the Oodle check stayed red whatever the reviewer thought. The only ways through were an administrator bypassing branch protection, or `fail-on-blocking: false`, which turns the gate off for everyone.

We found this by adopting Oodle on an ordinary service, as its target user would. Adding a harmless field to a response blocked with no way to unblock. Updating the outcome to expect the field made it `redefined`, which blocked too. A gate that every intended change has to be bypassed around gets bypassed for everything, and soon nobody reads it.

Two things make approval harder than a button:

1. **What was approved has to be what merges.** If a reviewer approves "the confirmation gained a `currency` field" and a later push changes the value of that field, the approval must not carry over.
2. **Who approves has to be someone other than whoever made the change.** That's the point of 0006 for agents, and it applies to people too.

## Decision

1. **Every change to a promise gets a fingerprint.** A `changed`, `redefined` or `removed` outcome, and a `redefined` or `removed` constraint, carries an 8-character `fingerprint`. It's a hash of the definitions before and after and, for `changed`, the observed boundary output before and after under every condition. Any difference in what changed gives a different fingerprint.
2. **An approval is `id@fingerprint`.** `oodle check` and `oodle diff` take `--approve id@fingerprint` (repeatable) and `--approvals <file>`. An approval that matches a finding's id and fingerprint unblocks that finding. The finding is still reported, marked approved and by whom. An approval that matches nothing is reported as **stale** with the reason, and unblocks nothing.
3. **Broken things are never approvable.** A `broken` or `failing` outcome, a constraint violation, a violation on an unknown route and a lint error have no fingerprint. To ship a change that breaks an outcome on purpose, redefine the outcome in the catalog, and approve the redefinition. The record of the decision is then the catalog itself.
4. **In GitHub, approvals come from the pull request.** The Action reads `/oodle approve <id@fingerprint> ...` lines from pull request reviews and comments, and keeps only those by people with write access (`OWNER`, `MEMBER`, `COLLABORATOR`), never bots, and never the pull request's author unless `allow-self-approval: true`. The outcome diff comment prints the exact line to paste. A `pull_request_review` trigger re-runs the check when the review is submitted.

## Options considered

### A. An approvals file committed in the pull request

- Good: works on any CI, and leaves a record in history.
- Bad: the author writes it, so it approves nothing unless code owners review the file, and it goes stale on main the moment it merges.

### B. A pull request label such as `oodle-approved`

- Good: one click.
- Bad: approves everything at once, including changes pushed after the label went on, and anyone with triage access can add a label.

### C. Fingerprinted approvals from reviews (chosen)

- Good: approves exactly one change as it is now, names who approved, works locally with `--approve`, and needs nothing but a review.
- Bad: approving takes a pasted line, and re-approving is needed after any push that changes the finding.

### D. Let any approving GitHub review unblock

- Good: no new syntax.
- Bad: a review approves the code, not a change to what customers are promised, and branch protection already requires reviews. It wouldn't be a separate decision.

## Consequences

- An intended change to a promise can merge with a green check, and the comment says who approved it.
- A broken outcome still can't merge without changing the catalog, which is itself a reviewed, approvable change.
- Fingerprints depend on the observed output, so an app whose output isn't deterministic (wall-clock time, random ids) produces a new fingerprint on every run. `oodle doctor` now runs the catalog twice and reports any output that differs between identical runs, and the `oodle/adapter` makes time, uuids and `Math.random` deterministic.
- The repository's own Oodle check runs in its own workflow, so a review re-runs only that check and never skips another required check.

## Revisit if

- Teams want approvals from systems other than GitHub (GitLab, Buildkite). The `--approvals` file is the seam.
- Re-approving after every push becomes the common complaint. Then consider fingerprints that ignore changes under a reviewer's chosen paths.
- People paste approval lines without reading the diff. Then consider requiring the approving review to be an `APPROVED` review.
