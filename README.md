<p align="center"><img src="assets/oodle.svg" width="200" alt="Oodle, the OODLC mascot, waving"></p>

# OODLC · Open Outcome Delivery Lifecycle

**OODLC** (say "oodle-see") is an open framework for delivering outcomes, not code. **Oodle** is its CLI: CI that protects outcomes and watches behavior.

Agents make code cheap and replaceable. What has to survive every rewrite is what the customer experiences. In OODLC you declare those **outcomes**, and Oodle protects them: every change runs against them in a simulated world, and Oodle reports an **outcome diff** instead of a wall of green checks. Everything else the system does is **behavior**. Oodle notices it and tells you when it drifts, but never blocks on it.

```
## Outcome diff: **1 blocking**

3 held · 0 changed · 1 broken · 0 new · 0 removed · 0 redefined · 0 unknown · 1 behavior changes

| ❌ broken (blocking) | checkout.payment-confirmed | customer | [first_purchase] body.order_id: missing |

### Behavior changes (report only)
- `ops.health` changed: [default] body.version added
```

Status: **v0, milestones 1–2** (spec, lint, runner, effect recorder, differ, gap finder) plus the GitHub Action. The drafter and MCP server come next.

## Quick start

```bash
npm install
npx oodle hello                          # meet Oodle
npx oodle doctor examples/checkout       # is everything wired up?
npx oodle run examples/checkout          # run every outcome and behavior under every condition
npx oodle check examples/checkout        # outcome diff against your default branch
npx oodle init my-service                # start your own project
npm test                                 # the seeded scenarios
```

## The CLI

```
oodle run [project]            Run every outcome and behavior under every condition
oodle check [project]          Outcome diff of the working tree against a git ref
oodle diff <base> <head>       Outcome diff between two project checkouts
oodle lint [project]           Validate the catalog and its traceability
oodle init [dir]               Start a project: an oodlc/ folder, a starter catalog and app
oodle doctor [project]         Check your environment and project setup
oodle completion <shell>       Print a bash, zsh or fish completion script
```

- **Finds the project.** Run it from anywhere inside a project, and it walks up to the nearest `oodlc/` folder.
- **Readable in a terminal, clean in a pipe.** Results go to stdout; Oodle, progress, hints and errors go to stderr. Colour follows `NO_COLOR`, `FORCE_COLOR` and `--color`.
- **Made for scripts and agents.** `--json` (or `OODLE_FORMAT=json`) prints exactly one JSON document, errors included. `oodle help --json` describes the whole CLI.
- **Helps you get unstuck.** Every error says what to do next, typos get a "did you mean", and each run ends with a suggested next step.
- **Fits the inner loop.** `oodle run --watch --only "checkout.*"` re-runs one slice on every save.
- **Native in CI.** `uses: oodlc/oodle@v0` keeps one outcome-diff comment updated on every pull request. Findings become annotations and the diff goes to the job summary.
- **Predictable exit codes.** `0` ok, `1` blocking, `2` could not run, `130` interrupted. Ctrl-C cleans up after itself.

The full reference is in [`docs/cli.md`](docs/cli.md).

Oodle checks itself, too. The root [`oodlc/`](oodlc/) folder declares Oodle's own promises, and CI blocks any pull request that breaks one. See [CONTRIBUTING](CONTRIBUTING.md#oodle-checks-itself).

## Three layers

| Layer | Who writes it | Durable? | Example |
| --- | --- | --- | --- |
| **Intent** | Human | Yes | Customers can buy without surprises |
| **Outcome** | Declared, human-approved | Yes, by definition | Paying shows a confirmation and sends one receipt |
| **Behavior** | Observed by the runner | No, by default | Checkout emits `internal.audit` |

1. **Intents** say why the product exists. **Outcomes** say what it must do for someone outside the system (customer, external caller, owned data, obligations), each traced to an intent.
2. **Behaviors** are what the runner sees the system doing. Agents may change them freely. To protect one, promote it to an outcome.
3. The app talks to the outside world only through `ctx.effects`, so the runner can stub every external call and record every side effect. That is the simulation.
4. Every change runs base and head, then classifies each outcome: `held`, `changed`, `broken`, `failing`, `new`, `removed`, `redefined`. Any of those except `held` and a passing `new` blocks the merge until a human approves.
5. Behavior changes, including internal effects under an outcome, are reported only. Routes no outcome or behavior describes are `unknown`: probed in simulation and returned as an observed behavior, ready to keep or promote.
6. **Constraints** hold on every run: outcomes, behaviors and probes of unknown routes. A violation always blocks, and so does changing or removing a constraint.

The rule underneath all of it: **only what a human declared can block** (outcomes and constraints). The reasoning is in [`docs/decisions/`](docs/decisions/).

## Writing a catalog

Everything Oodle needs lives in one visible folder, `oodlc/`, at the project root ([0003](docs/decisions/0003-one-visible-oodlc-folder.md)). `oodlc/config.yaml` says how to run the app. Every other YAML file in the folder is catalog, and any file can hold any of the five sections: `intents`, `outcomes`, `behaviors`, `conditions`, `constraints`.

```
my-service/
  oodlc/
    config.yaml        # how to run the app
    intents.yaml       # why the product exists
    checkout.yaml      # outcomes, behaviors, conditions, constraints: split however you like
  src/app.ts           # your app, wherever it already lives
```

Give `oodlc/` a `CODEOWNERS` entry and outcome changes get the right reviewers. A project from v0 (`oodle.yaml` + `catalog/`) still runs; `oodle init --migrate` moves it into `oodlc/` with its git history.

```yaml
# oodlc/config.yaml
app: src/app.ts          # default export createApp(ctx), relative to the project root
defaults:
  given:
    state: { customers: [{ id: c1, email: ada@example.com }] }
    stubs:
      payment.capture: { result: { id: pay_1, status: succeeded }, latency_ms: 120 }
```

```yaml
# oodlc/checkout.yaml
version: 0
outcomes:
  - id: checkout.payment-confirmed
    intent: buy-without-surprises   # required: an outcome with no intent is a lint error
    statement: After a successful payment the customer sees a confirmation and gets exactly one receipt
    boundary: customer              # customer | external | data | obligation | internal
    trigger:
      http: POST /checkout
      given:
        body: { customer_id: c1, items: [{ sku: tee, qty: 2 }] }
    conditions: [first_purchase, payment_provider_slow]
    expect:
      status: 200
      body:
        order_id: { exists: true }     # matchers: exists, type, matches, contains, gte, lte
        status: confirmed              # or a literal value
      effects:
        - { kind: email.sent, match: { template: receipt }, count: 1 }
      latency_ms_max: 2000
    constraints: [no-charge-without-order]
```

```yaml
# oodlc/ops.yaml
version: 0
behaviors:
  - id: ops.health
    statement: Health endpoint answers ok
    boundary: internal
    trigger:
      http: GET /health
    observed:                # optional snapshot; a mismatch is drift, not a failure
      status: 200
      body: { ok: true }
```

- **Promoting** a behavior means moving it from `behaviors` to `outcomes`, giving it an intent and turning `observed` into `expect`. An id can't be both. Promotion never blocks. **Demoting** removes an outcome, so it does block.
- A behavior on any boundary other than `internal` gets a lint warning asking for that decision.
- **Conditions** are named variants (`given` state, stubs or body) layered over the outcome or behavior: `defaults` → item → condition.
- **Constraints** are invariants written as a JS expression over `effects`, `state` and `response`. Every constraint is checked on every run, and a check that throws counts as a violation. The `constraints:` list on an outcome is traceability only. See [0002](docs/decisions/0002-constraints-hold-on-every-run.md).
- **Latency** is real in-process time plus the simulated latency of stubbed calls, so `payment_provider_slow` costs 1.5s of simulated time and zero real time.

Full schema: [`spec/catalog.schema.json`](spec/catalog.schema.json).

## The app contract

```ts
import type { CreateApp } from 'oodle/src/contract';

const createApp: CreateApp = (ctx) => ({
  routes: [{ method: 'POST', path: '/checkout' }],
  async handle(req) {
    const payment = await ctx.effects.call('payment.capture', { amount_cents: 6200 }); // stubbed in simulation
    ctx.effects.emit('email.sent', { template: 'receipt' });                         // recorded, crosses the boundary
    ctx.effects.emit('internal.audit', { event: 'order_created' });                  // internal: behavior only
    return { status: 200, body: { order_id: ctx.id('ord') } };
  },
});
export default createApp;
```

Ids and time come from `ctx` so runs are deterministic. Effect kinds starting with `internal.` never affect an outcome; everything else crosses the boundary.

## Meet Oodle

<p align="center"><img src="assets/oodle-moods.svg" width="720" alt="Oodle's moods: hello, happy, curious, worried, oops"></p>

Oodle is a small noodle with a curl on top and a wiggly tail. Outcomes are what Oodle protects; behaviors are what Oodle notices.

- **Personality:** calm, plain-spoken, a little delighted by a tidy catalog. When an outcome breaks, Oodle says what broke and stops there. No cuteness about real breakage.
- **Moods:** `happy` (teal) when every outcome holds, `curious` (violet) when behavior drifts or a route is new, `worried` (amber) when something blocks, `oops` (coral) when Oodle can't finish.
- **In the terminal** Oodle blinks, then reacts after every `lint`, `run`, `diff` and `check`. `oodle hello` waves.
- **On PRs** the markdown signs off with `(^ᴗ^)~ checked by Oodle`.

```
      ∿
   ╭───────╮
  ( ◕ ᴗ ◕ )~  Hi! You declare outcomes, I watch behaviors.
   ╰─┬───┬─╯
     ╵   ╵
```

Oodle only talks on stderr and only in a terminal, so `--json`, `--md` and piped output stay clean. `--quiet` (or `OODLE_QUIET=1`) hushes Oodle, `OODLE_STILL=1` (or `CI`) stops the animation, and `NO_COLOR` and `--no-color` are honoured. The artwork is generated by [`scripts/oodle-art.py`](scripts/oodle-art.py).

## What the demo proves

`test/scenarios.test.ts` seeds changes into `examples/checkout` and checks the diff:

| Change | Result |
| --- | --- |
| Rename internals, rename an internal effect | All outcomes held, behavior change reported, nothing blocks |
| Rename `order_id` → `orderId` | outcome `broken`, blocking |
| Add `GET /orders/:id` that nothing describes | `unknown`, probed, observed behavior proposed |
| Store `payment_id: null` on orders | `broken` via the `no-charge-without-order` constraint |
| Add `currency` to the checkout response | outcome `changed`, blocking until reviewed |
| Loosen an outcome's latency budget | `redefined`, blocking until approved |
| Health endpoint returns an extra field | behavior `changed`, reported, nothing blocks |
| Promote `ops.health` to an outcome | outcome `new`, behavior marked promoted, nothing blocks |
| Delete an outcome | `removed`, blocking |
| Health endpoint captures a payment with no order | constraint violated on a behavior run, blocking |
| Add `POST /quick-buy` that charges without an order | constraint violated on an unknown route, blocking |
| Loosen `no-charge-without-order` | constraint `redefined`, blocking until approved |
| A constraint check throws | fails closed, blocking |

## Not yet

Learned simulation models, probes against real environments, event and schedule triggers, multi-service systems, UI outcomes, the drafter (`oodle draft brief.md`) and the MCP server.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Changes to what blocks a merge or what the catalog means need a [decision record](docs/decisions/).

## License

Apache-2.0
