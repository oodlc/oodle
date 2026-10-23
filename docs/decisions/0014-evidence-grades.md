# 0014. Evidence is graded observed or inferred, and coverage is not absence

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Builds on:** [0010. The inventory](0010-capabilities-and-the-inventory.md) ("Revisit if evidence needs grades or sources Oodle can check, rather than free text"), [0011. A project with no app](0011-explain-what-oodle-cannot-run.md)

## Context

Since 0.9.0 a capability's `evidence` is free text. `oodle discover` writes most of it, and the lines it writes come from two kinds of source that read the same:

- **What Oodle saw happen:** the routes the app serves, how a probe answered, the calls and table writes it recorded, the requests in a HAR capture or an OTLP trace export.
- **What someone wrote:** an OpenAPI spec's summaries, the outcomes that describe a route, and anything an agent or a person puts in a proposal.

Nothing told them apart. Today that matters in four places:

- `oodle interview` asks about the capabilities with the most evidence lines first, so a spec with long descriptions, or an agent that proposes a capability with many lines of its own, moves it up the queue.
- `oodle explain --only` prints evidence with no word on where it came from. In a project with no app (0011), a capability drafted from a spec alone looks as backed as one drafted from traffic.
- An agent can propose a capability with evidence that claims anything, through `oodle propose` or the MCP `propose` tool.
- A capture that never reached a route wrote `no requests in session.har` as evidence, and a question asked "Is it still used?". A 40-minute capture of three hosts can't say a route is unused.

Coverage (an outcome protecting a capability) and lint never read evidence: they count outcomes, by the `capability` they name or the surfaces that reach their trigger. Discovery already orders capabilities by traffic only. So the gap is in what people and agents are shown and asked, not in what blocks.

## Decision

1. **Every evidence item is `observed` or `inferred`**, written `{ text, grade }`.
   - **observed:** a route the running app serves, a probe's answer, recorded effects and table writes, requests in a capture or trace export.
   - **inferred:** a spec's descriptions and any other human-written text, statements an agent drafted, anything written through the MCP `answer` tool, and anything else Oodle didn't see happen.
2. **Fail closed.** Free text, or an item with no grade, loads as `inferred`. Catalogs from before 0.14.0 load unchanged, with all their evidence inferred.
3. **Oodle sets the grade from where the evidence came from.** Only `oodle discover` writes `observed`, through an internal path no CLI flag or MCP argument reaches. `oodle propose` and the MCP `propose` tool grade every item they are given `inferred`, whatever it claims. The `answer` tool refuses evidence. The Claude Code hook asks the person before an edit adds evidence graded `observed`.
4. **Nothing inferred ranks or covers.** Only observed traffic orders capabilities by use, and only observed evidence orders the interview. Coverage and protection stay computed from outcomes, never from evidence.
5. **`explain` shows the grade** beside each piece of evidence, and marks a capability **inferred only** when nothing Oodle saw backs it: no observed evidence, and none of its outcomes or behaviors ran. Running is seeing, so that is decided on every run and never stored.
6. **Coverage is not absence.** Every `--from` file records its scope: kind, file, first and last request, request count, and hosts. A question about a capability no request reached cites that scope: "Not seen in 1 HAR capture, session.har (40 min, 312 requests, hosts: a, b, c). That doesn't mean it's unused." A capture's silence leaves no evidence line, and nothing Oodle prints calls a route dead or unused from absence alone. These questions are asked of every capability a capture didn't reach, not only new ones, and are named `unseen.<capability>`.
7. **Grades describe evidence, not entries.** Confirming a capability is still deleting `status: proposed` (0010). A confirmed capability can have only inferred evidence, and a proposed one can have observed evidence.

Nothing here blocks. The rule from 0001 stands: only what a person declared can block.

## Options considered

### A. Keep free text, and ask people to write where each line came from

- Good: no format change.
- Bad: nothing checks it, and the lines that most need a source (an agent's) are the least likely to have one.

### B. A grade on the capability instead of on each piece of evidence

- Good: one field.
- Bad: a capability's evidence is mixed: the spec's words and the traffic that confirms them. And it would be a second way to say "a person hasn't confirmed this", next to `status: proposed`, which 0010 rejected.

### C. A `source` on each item (`probe`, `har`, `openapi`, `agent`), with the grade derived from it

- Good: more precise.
- Bad: anyone can write `source: har` as easily as `grade: observed`. Precision doesn't buy trust; who writes the grade does. The text already names the file.

### D. Two grades per item, set by Oodle from where it came from, failing closed (chosen)

- Good: the only distinction that changes what Oodle does: what may rank, and what explain may call seen.
- Good: old catalogs load, and are honest about what they are.
- Bad: a person who saw something in production logs can't record it as observed by hand without the hook asking. That's deliberate: Oodle didn't see it.

## Consequences

- `spec/catalog.schema.json`: an evidence item is a string or `{ text, grade? }`. oodlc.com serves the schema from the repository.
- `oodle discover` writes graded items, adds `<route>: served by the app` (observed) in projects with an app, drops `no requests in <file>`, and returns each file's `scope` in its JSON. The `unused.<capability>` question becomes `unseen.<capability>`; an existing `unused.` question is not asked again.
- `oodle explain` and the `map` tool gain `inferred_only` per capability and in the summary. The MCP `catalog` tool lists evidence with grades. `oodle interview` shows the grade before each line.
- A team that only ever wrote evidence by hand sees all of it as inferred, and every capability without outcomes as inferred only. That is accurate.

## Revisit if

- Teams want to record observations Oodle can't make itself (production logs, support tickets) as observed. That would need a source Oodle can read and check, like `--from`, not a hand-written grade.
- Scope needs to be kept in the catalog, so a later `explain` can say what was covered without the original file.
- Inferred-only capabilities should be called out by lint, not only by `explain`.
