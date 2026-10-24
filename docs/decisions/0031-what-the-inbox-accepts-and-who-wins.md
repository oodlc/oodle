# 0031. What the inbox accepts from tokens, and who wins when people disagree

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

The guide (10.3, 10.4, 8.5) says: tokens push and pull but never answer or approve for people; agent gaps that arrive settled are stored `applied`; a changed gap with an answer reopens; answers use optimistic concurrency on the gap's `version`; and when two people answer the same gap, the first wins and the second is surfaced as a conflict. It does not say:

- what to do with a human-routed gap that arrives already answered, which is legal when a person answered at their own terminal (8.3);
- what happens when a gap first pushed open is later pushed settled, since the content hash leaves out the answer fields and so doesn't change;
- how a conflict is stored, shown and resolved;
- where the inbox keeps what it needs beyond the 10.2 schema.

## Decision

**Tokens.**

1. Any `/api/ui/*` request with `Authorization: Bearer` is refused with 403 `token_not_allowed`, even if it also carries a valid Access JWT. No `/api/v1` route creates answers or approvals.
2. A pushed human-routed gap whose file carries an answer is accepted only if `answered_by` is `person:*` (a person at their terminal). It is stored as the file says (`applied` once it has `applied_in`, else `answered` or `dismissed`), with a `gap.settled_locally` event, and no answer row. Any other answer on a human gap fails the whole push with 403 `token_cannot_answer`, and nothing in the push is written.
3. Agent-routed gaps that arrive settled are stored `applied`. If the same content was pushed open earlier and nobody answered it in the inbox, the later settled push records the settlement, even though the content hash is unchanged. This is the one exception to "unchanged hash, touch nothing".
4. Pushes are validated whole before any write, and written in one D1 batch.

**People.**

5. An answer is accepted when the sent `version` matches. Otherwise 409 `version_mismatch` with the current gap.
6. A person may change their own answer, and may override an answer an agent settled. Each new answer gets a new id and seq; the CLI applies answers in seq order, so the latest wins.
7. If another person's answer already stands (the gap is answered, dismissed or applied) and this answer differs, it is a conflict: stored in a `conflicts` table, logged as `gap.answer_conflict`, counted on the gap (`open_conflicts`), returned as 409 `conflict`. It is not pulled by the CLI. The same answer from a second person is not a conflict.
8. The person whose answer stands, or a project owner, resolves it: **keep** closes it; **take** makes the conflicting answer the standing one, in its author's name, with a new seq. Gaps with open conflicts show in the inbox next to open gaps.
9. Concurrent answers to one gap: the gap update is conditional on the version, and the counter, answer row and event are each conditional on the gap pointing at the new answer, all in one batch. Exactly one wins; the others get 409 (and a conflict if 7 applies).

**Schema additions to 10.2**: `gaps.answer_id` (the standing answer), `gaps.note` (why it reopened), `gaps.created_at` (inbox age), the `conflicts` table, and indexes on `tokens.hash`, `members.email`, `answers(gap)`, `approvals(intent)`, `approvals(seq)`.

**Wire extensions**, all optional, in `apps/inbox/src/shared/protocol.ts`: `evidence.scenario_text`, `options[].becomes.replaces`, `tier_reason`, `intent_id` on the gap file (`intent` is also read), and `answered_at` / `id` / `at` / `note` on pulled answers and approvals.

## Options considered

### A. 403 on any pushed human gap that carries an answer

- Good: simplest rule.
- Bad: breaks `oodle sync` for a person who answered at their terminal, which 8.3 allows. The token isn't answering; it is reporting a file a person already changed in git.

### B. Last writer wins between people

- Good: no conflicts table.
- Bad: one person silently overwrites another; 8.5 asks for the opposite.

### C. Store the second answer as an answer row with a flag

- Good: one table.
- Bad: every query that pulls or shows answers has to filter it out, and a missed filter sends it to the CLI.

## Consequences

- The CLI can push gap files unchanged, whatever their state, and will only be refused when a file claims a non-person answer on a human gap.
- Local person answers on human gaps are trusted as the policy boundary 8.3 describes, not verified.
- A conflict needs someone to come back to it; until then the first answer counts and is what the CLI applies.

## Revisit if

- Local person answers turn out to be used to skip review: require human gaps to be answered in the inbox.
- Conflicts pile up unresolved: notify the first answerer, or time them out.
