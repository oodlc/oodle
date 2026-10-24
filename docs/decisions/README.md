# Decision records

Design decisions that shape Oodle, written down so contributors can see why things are the way they are, and what would change our minds.

| # | Decision | Status |
| --- | --- | --- |
| [0019](0019-reset-the-spec-is-the-product.md) | Reset: people manage the spec, code is generated and checked against it | Proposed |
| [0020](0020-the-spec-on-disk.md) | The spec on disk: two layouts, one hash, writers that change only what they mean to | Proposed |
| [0021](0021-the-simulation.md) | The simulation: Miniflare instances reset between scenarios, controlled through sim-only routes | Proposed |
| [0022](0022-compile-and-verify.md) | Compile and verify: a derived vocabulary, four kinds of check, one model client | Proposed |
| [0023](0023-gaps-from-two-builds.md) | Gaps: differences grouped by cause, questions that say what they write | Proposed |
| [0024](0024-the-generator.md) | The generator: one agent per build, fenced in, checked after | Proposed |
| [0025](0025-answers-and-the-local-loop.md) | Answers and the local loop: who may answer what, and how it lands in git | Proposed |
| [0026](0026-intents.md) | Intents: structured changes, approvals bound to content, merged-only checks | Proposed |
| [0030](0030-the-inbox-runs-as-one-worker.md) | The inbox runs as one Worker: plain Vite assets, a small router, seeding by SQL | Proposed |
| [0031](0031-what-the-inbox-accepts-and-who-wins.md) | What the inbox accepts from tokens, and who wins when people disagree | Proposed |

Records 0001 to 0018 describe v0 and are at tag [`v0.19.0`](https://github.com/oodlc/oodle/tree/v0.19.0/docs/decisions). Numbering continues from 0019.

## When to write one

Write a record when a change alters what blocks a build, what the spec means, or its shape, or when reasonable people would choose differently.

## How

1. Copy [`template.md`](template.md) to the next number.
2. Open it as **Proposed**, in the same pull request as the change or ahead of it.
3. Once merged it becomes **Accepted**. Records are not edited after that. To change a decision, write a new record that marks the old one **Superseded by 00NN**.
