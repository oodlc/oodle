# Oodle

People manage the spec: what the app is for, who uses it, what it holds, what they go through and what must never happen. Code is generated from it and checked against it. Merge the intent, not the code.

[VISION.md](VISION.md) is the model. This page is how to use what exists: the first slice, on one stack (Hono on Cloudflare Workers with D1). It is early. [0019](docs/decisions/0019-reset-the-spec-is-the-product.md) says why Oodle was reset; the previous Oodle (v0, outcomes guarding code people write) is at tag [`v0.19.0`](https://github.com/oodlc/oodle/tree/v0.19.0).

## The loop

```
oodle init --example     # a spec to start from: the dog-walking app in VISION.md
oodle compile            # journeys, constraints and decisions, into what the simulation runs
oodle build              # Claude Code generates the app; Oodle verifies it and keeps its decisions
oodle gaps               # builds twice, diffs what users see, asks about each difference
oodle answer --auto      # the local agent settles what the spec left to the builder
oodle sync               # people answer the rest, and approve changes, in the inbox
```

Everything but the inbox works offline with no account. `oodle build`, and anything a model words or judges, uses Claude Code's credentials (an API key or `claude` logged in).

## The spec

Six kinds of entry, in `oodle/`: one file (`oodle/spec.yaml`) or one file per section (`intent.yaml`, `personas.yaml`, `domain.yaml`, `journeys/*.yaml`, `constraints.yaml`, `decisions.yaml`). [examples/dogwalk](examples/dogwalk) is the second.

| Entry | Tier | Written by |
| --- | --- | --- |
| Intent, personas, domain, journeys, constraints | Declared | People. Nothing else changes them. |
| Decisions | Decided | The generator, where the spec is silent. People can override any of them. |

Next to them, Oodle keeps:

- `oodle/compiled/`: what the simulation runs, derived from the spec and committed, so anyone can read it. `oodle compile --check` shows each journey line next to the steps it became.
- `oodle/gaps/`: one question per difference two builds showed, with the evidence and what each answer writes.
- `oodle/intents/`: changes to the app, agreed before any code exists.
- `oodle/oodle.config.yaml`: routing, the inbox, the exploration cap, the base ref for intents.

## Build and verify

`oodle build` writes `AGENTS.md` from the spec and runs Claude Code in `.oodle/builds/<id>/app/`. The agent can't write the spec, can't reach the network, and can run only install, typecheck and the checks. After it runs, Oodle checks that the spec is untouched and that the code takes time, ids, randomness, mail and outbound requests only from `@oodle/runtime`. Then it verifies the build:

- **every journey**, step by step, against what the screen shows;
- **every constraint** checked on every build;
- **every pinned decision**;
- **the exploration plan**: lists with 0, 1, 7 and 60 items, every persona trying every action, every pair of state changes, both sides of every time rule, and odd inputs.

A failure names the journey, the step and its line of prose. New decisions join `decisions.yaml` only when the build passes. A build that would change a pinned decision asks a person instead.

Builds run in a sealed simulation (Miniflare, D1 in memory, no network), so the same build always answers the same way.

## Gaps

`oodle gaps` builds the app twice, independently, runs both through the same scenarios and diffs what a user would see. Each difference becomes a question in `oodle/gaps/`:

```yaml
kind: sort_order
tier: decided            # any answer is a decision the spec left open
route: agent             # so the local agent may settle it
question: Which order should owners see their walks in?
evidence:
  scenario_text: "Ada: book walks ×7; Ada looks at walks"
  a: { summary: Soonest first, sample: [...] }
  b: { summary: Newest booked first, sample: [...] }
options:
  - { id: a, label: Soonest first, becomes: { decision: "Walks are listed by starts_at, soonest first" } }
  - { id: b, label: Newest booked first, becomes: { decision: "Walks are listed newest booked first" } }
  - { id: dont_care, label: Either is fine }
```

Permission and rule questions are declared-tier and go to people. So does any question where one build breaks the spec, and any change to a pinned decision. When no gaps are left, the builds agree.

## Answers

- `oodle answer <gap> --option a`: at a terminal, as you (`person:<git email>`).
- `oodle answer --auto`: the local agent settles every question routed to agents, and says why.
- In the inbox: people answer in a browser, and `oodle sync` applies the answers.

Every answer that lands is a commit, `oodle: apply g_… (<who>)`. Without a terminal, anything that needs a person exits with code 3 and says where to answer it.

## Intents

```
oodle intent new cancel-fee           # what should change, why, what stays true, what it rules out
oodle intent review i_cancel_fee      # builds the change twice and asks about what it leaves open
oodle intent approve i_cancel_fee     # people only; in the inbox or at a terminal
oodle intent merge i_cancel_fee       # writes its changes into the spec, in one commit
oodle build                           # checked against what the intent said
```

An approval is for the intent as it was. Edit the intent and the approval no longer counts. Builds read intents from the base ref (`main`), so a branch can't approve itself by adding one.

## The inbox

[apps/inbox](apps/inbox) is one Cloudflare Worker with D1 and a small web app, behind Cloudflare Access. People answer questions and review intents there. It has no code view. `oodle login <url> --project <id>` stores a project token in the OS keychain; `oodle sync` pushes gaps and intents, pulls answers and reviews, and applies them. A project token can push and pull, but never answers for a person.

## Develop

```
pnpm install
pnpm -r build
pnpm test
pnpm lint
```

Node 22+, pnpm. [docs/implementation-guide.md](docs/implementation-guide.md) is the build plan, [docs/decisions/](docs/decisions/README.md) records why things are the way they are, [docs/cli.md](docs/cli.md) lists every command, and [docs/open-questions.md](docs/open-questions.md) logs what building it teaches.

## License

Apache-2.0
