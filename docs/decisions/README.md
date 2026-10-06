# Decision records

Design decisions that shape OODLC and Oodle, written down so contributors can see why things are the way they are, and what would change our minds.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-outcomes-and-behaviors.md) | Outcomes are declared, behaviors are observed | Accepted |
| [0002](0002-constraints-hold-on-every-run.md) | Constraints hold on every run | Accepted |
| [0003](0003-one-visible-oodlc-folder.md) | Everything lives in one visible oodlc/ folder | Accepted |
| [0004](0004-conditions-carry-expectations.md) | Conditions can carry their own expectations, and Oodle ships a security pack | Proposed |
| [0005](0005-sealed-simulation.md) | The simulation is sealed: reaching the real network is a violation | Proposed |
| [0006](0006-proposals-and-propose-only-agents.md) | Agents propose, humans approve: `status: proposed` and propose-only writes | Proposed |
| [0007](0007-approvals-in-ci.md) | A change to a promise is approved in the pull request, bound to exactly what changed | Proposed |
| [0008](0008-nextjs-through-its-own-route-module.md) | Next.js route handlers run through Next's own route module | Proposed |
| [0009](0009-a-real-database-in-the-simulation.md) | The simulation includes a real Postgres, and what the app writes to it is behavior | Proposed |

## When to write one

Write a record when a change alters what blocks a merge, what the catalog means, or the shape of the schema, or when reasonable people would choose differently. Bug fixes and refactors don't need one.

## How

1. Copy [`template.md`](template.md) to the next number, e.g. `0003-short-title.md`.
2. Open it as **Proposed** in the same PR as the change, or ahead of it to discuss.
3. Once merged it becomes **Accepted**. Records are not edited after that. To change a decision, write a new record that marks the old one **Superseded by 00NN**.
