# 0023. Gaps: differences grouped by cause, questions that say what they write

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

The gaps check builds the app twice, runs both builds through the same scenarios and turns each user-visible difference into a question. A raw diff is noisy: one sort order changes every list in every scenario, and one refused action changes every step after it. The guide sketches normalizing, patterns and a signature hash. It leaves open how fine a signature is, what an answer may write to the spec, and what happens with the gap files across runs.

## Decision

1. **Normalize ids only.** Each side's generated ids become symbols by first appearance within a scenario. Text is otherwise compared as the view model reads it: whitespace collapsed, case kept.
2. **Patterns.** `sort_order` (same items, other order), `pagination` (one list is a cut of the other, five items or more), `extra_element` (one side only adds), `format` (the same words, with numbers, written differently: "Wed 4 Nov, 09:00" and "2026-11-04 09:00"), `wording` (the rest), `permission` (refused on one side only, in a permissions scenario), `rule` (refused on one side only, elsewhere) and `other` (a step failed on one side).
3. **A refusal absorbs what follows.** Once an action is refused on one side only, every later difference in that scenario folds into it.
4. **Two grains of signature.** Sort order, pagination, permission and rule gaps are signed by pattern, place (`screen:walks`, `action:owner.cancel_walk`) and entity, plus the acting persona for permissions, because the same cause shows different samples in different scenarios. Wording, format and extra elements are signed by pattern and by the words only one side shows, with names, weekdays, months and digits blanked, and not by place: the same choice ("Signed in as Ada" at the top of every screen, a date format) is one question wherever it shows up. On the first real run, signing these by place and sample gave 85 questions for two builds; signing by what differs gave 24. The id is `g_` plus 8 hex characters of the hash.
5. **What an answer writes** (`options[].becomes`) is one of:
   - a `decision`;
   - a `constraint`;
   - a domain `rule` (`{entity, text}`);
   - a persona's `cannot` (`{persona, text}`).

   Only the first is decided-tier. The other three exist so that permission and rule gaps, which are declared-tier, can be answered by a person in one click.
6. **The question is worded by a model when there is one**, and by a template otherwise, so the gaps check works offline. A model answer that doesn't fit the schema falls back to the template. Only permission and rule questions may offer declared-tier answers; the schema for every other question allows decisions only.
7. **Tier rules**:
   - permission and rule gaps are declared;
   - a gap where one side breaks a journey expectation or a compiled constraint is declared;
   - a moved decision always goes to a person;
   - `other` goes to a model, or is declared when there is no model;
   - everything else is decided.

   The reason is written in `tier_reason`.
8. **Across runs.** A gap found again keeps its file. An open gap gets fresh evidence; an answered, applied or dismissed one is left as it is. An open gap a later run of the same scope doesn't find is removed and reported as superseded. A dismissed gap's id goes in `oodle/gaps/.ignore.yaml` and is never raised again.
9. **Additions to the gap file**: `tier_reason`, `evidence.scenario_text` (the scenario in plain words), `evidence.seen_by`, `intent_id` (for gaps an intent review raised) and `history` (answers a later one replaced).

## Options considered

### A. Sign every difference by its samples

- Good: simple and exact.
- Bad: a sort order seen with 7 and with 60 items would be two questions about one choice.

### B. Sign by place for causes that repeat across scenarios, by content for the rest (chosen)

- Good: on the two hand-written fixtures, exactly the three planted differences come out, with the same ids on every run.
- Bad: two different sort orders on one screen (say, by date and then by walker) would merge into one question. Answering it pins one order, and the next run raises whatever still differs.

## Consequences

- `oodle gaps` needs no model to run; with one, its questions read better.
- Declared-tier answers write to the declared tier, so the tier guard has to let them through when a person answered (see 0024).

## Revisit if

- People dismiss many gaps of one pattern: the normalizer should drop it (track it in `docs/open-questions.md`).
- Merged signatures hide real differences.
