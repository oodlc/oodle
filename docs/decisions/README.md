# Decision records

Design decisions that shape OODLC and Oodle, written down so contributors can see why things are the way they are, and what would change our minds.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-outcomes-and-behaviors.md) | Outcomes are declared, behaviors are observed | Accepted |
| [0002](0002-constraints-hold-on-every-run.md) | Constraints hold on every run | Accepted |

## When to write one

Write a record when a change alters what blocks a merge, what the catalog means, or the shape of the schema, or when reasonable people would choose differently. Bug fixes and refactors don't need one.

## How

1. Copy [`template.md`](template.md) to the next number, e.g. `0003-short-title.md`.
2. Open it as **Proposed** in the same PR as the change, or ahead of it to discuss.
3. Once merged it becomes **Accepted**. Records are not edited after that. To change a decision, write a new record that marks the old one **Superseded by 00NN**.
