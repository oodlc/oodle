# 0020. The spec on disk: two layouts, one hash, writers that change only what they mean to

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

[VISION.md](../../VISION.md) shows the spec as one YAML file and says the shape will change. The implementation guide asks for a folder of files as well (`intent.yaml`, `personas.yaml`, `journeys/*.yaml`…), for a hash that builds and gap runs are keyed by, and for writers that keep people's comments. It leaves open how the two layouts map to each other, what exactly the hash covers, and how much of a file a writer may touch.

One fact forced a choice: the README's own journey steps are not strings in YAML. `- Sam accepts: Ada sees "Accepted"` is a map with one key, because of the `: `.

## Decision

1. **Two layouts, one `Spec`.** `oodle/spec.yaml` holds every section as a top-level key. Otherwise each section has its own file, and each journey its own file under `oodle/journeys/`. Having both is an error. A section file holds the section itself, or a map whose only key is the section's name (`intent: …` reads better than a bare string). A journey's id is its file name; an `id:` that disagrees is an error. Every section is optional, so a half-written spec loads.
2. **A step that YAML read as a one-key map is the line it was.** `{ "Sam accepts": "Ada sees \"Accepted\"" }` becomes `Sam accepts: Ada sees "Accepted"`. A map with more keys is an error that says to quote the step.
3. **Short forms.** A bare decision string is `{ source: generator, status: pinned }` with id `d_` plus the first 8 hex characters of the SHA-256 of its text, lowercased and with whitespace collapsed. A bare decision's id follows its text; once it is written in long form, the id is fixed, and editing the text keeps it. A bare constraint string is a constraint whose `check` isn't classified yet.
4. **The spec hash** is the SHA-256 of the stable JSON (keys sorted) of:
   - the declared tier: intent, personas, domain, journeys keyed by id (so file order doesn't count), and constraints with their `check`;
   - the decided tier: each decision's `text`, `about` and `status`, in order.

   Layout, formatting, comments, key order and provenance (`id`, `source`, `answered_by`, `created_by_build`, `from_gap`) don't change it. Classifying a constraint does, because it changes how the spec is checked. Merged intents join the hash when intents exist (phase 9). `specHash(spec, { tiers: ['declared'] })` hashes one tier.
5. **The tier guard** compares the declared tier exactly as the hash sees it, and names every path that changed (`personas.owner.can: 1 added, "tip a walker"`).
6. **Writers change only what they mean to.** Writing a list (decisions, constraints) keeps every unchanged entry's exact bytes, keeps the comments and blank lines between entries, and leaves the rest of the file alone. Only new and changed entries are rendered. An inline comment on a bare entry moves to the first line of its long form. Decisions are always written in long form; a constraint stays a bare string until it has a `check`.

## Options considered

### A. Re-render the whole file through the YAML Document API

- Good: simple, and comments survive.
- Bad: it re-wraps long lines, re-pads flow lists and drops the alignment of inline comments in sections nobody touched. In the single-file layout, writing one decision rewrites the whole spec.

### B. Splice changed entries into the original text (chosen)

- Good: a diff of the spec shows exactly what changed, which matters when people review intents and answers as diffs.
- Bad: more code, and it only splices block lists. A flow list (`decisions: [a, b]`) or an empty one is re-rendered.

### C. Require one layout

- Good: one loader path.
- Bad: the README's example is one file, and a real spec with many journeys wants one file per journey.

## Consequences

- `examples/dogwalk/oodle/` is the README example in the split layout, and hashes the same as the README's single file. Tests check both.
- A comment *inside* a changed long-form entry (on one of its keys) is lost when that entry is rewritten. Comments above an entry are always kept.
- Writers for the declared tier (for `applyAnswer` and intents) aren't built yet. They should follow rule 6.

## Revisit if

- People edit specs mostly through the web inbox, not by hand, so preserving their formatting stops mattering.
- Steps need structure in YAML (a map per step with `as:`, `expect:`). The one-key-map rule would then be in the way.
- Provenance turns out to matter to what a build must do, and should be in the hash.
