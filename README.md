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

Status: **v0, milestones 1–2** (spec, lint, runner, effect recorder, differ, gap finder) plus the GitHub Action with approvals from reviews, the adapter for existing Express, Fastify, Koa, Hono and `node:http` services, and the agent toolkit: the security condition pack, the sealed simulation, `oodle mutate`, proposals, the drafter, the MCP server and the Claude Code plugin.

## Quick start

In your own service (Oodle isn't on npm yet, so it installs from GitHub):

```bash
npm i -D github:oodlc/oodle
npx oodle init --ci                      # wraps the service already here, adds the GitHub workflow
npx oodle doctor                         # is everything wired up?
npx oodle run                            # run every outcome and behavior under every condition
npx oodle check                          # outcome diff against your default branch
```

In this repository:

```bash
npm install
npx oodle hello                          # meet Oodle
npx oodle run examples/checkout          # a service built for OODLC
npx oodle run examples/express-orders    # an ordinary Express service, run through the adapter
npm test                                 # the seeded scenarios
```

## Adopting an existing service

`oodle init` finds the HTTP service already in the repository (Express, Fastify, Koa, Hono or `node:http`) and writes `oodle.app.ts`, which runs it through `oodle/adapter`. Your code doesn't change, except that the module that builds the app must export it without calling `listen()` on import. [`examples/express-orders`](examples/express-orders) is a complete example.

```ts
// oodle.app.ts
import { httpApp } from 'oodle/adapter';
import { app } from './src/server.ts';
import { store } from './src/repo.ts';

export default httpApp(app, {
  effects: {                                   // outbound fetch calls, by "METHOD host/path-prefix" or "host"
    'POST api.stripe.com/v1/charges': 'payment.charge',
    'POST api.stripe.com/v1/refunds': 'payment.refund',
    'api.sendgrid.com': 'email.sent',
  },
  setup(ctx) {                                 // before each run: point module-level stores at ctx.state
    store.users = new Map(Object.entries(ctx.state.users ?? {}));
    store.orders = new Map(Object.entries(ctx.state.orders ?? {}));
  },
});
```

- **Requests** go through the app's own middleware, in process. No port opens.
- **Outbound `fetch` calls** that match an `effects` rule become `ctx.effects.call(kind, payload)`: stubbed from `oodlc/config.yaml` and recorded. The payload is the parsed JSON, form or query. A stub result with `$status: 402` answers with that HTTP status. Anything else that reaches for the network is refused and blocks as an `oodle.sealed` violation, so nothing slips through untested. Clients built on `node:http` instead of `fetch` (axios, some SDKs) are refused too: give them a fetch-based client (Stripe: `Stripe.createFetchHttpClient()`), or call them through `ctx.effects`.
- **Time, `crypto.randomUUID`, random bytes and `Math.random`** are deterministic while a request runs, so identical code gives identical output and the outcome diff shows only real changes. `deterministic: false` turns this off.
- **Routes** are found on their own for Express and Hono, or listed with `routes: ['GET /health', ...]`, so Oodle can probe the ones no outcome describes.

`oodle doctor` then tells you whether Oodle is running your code or still a starter app, whether anything escapes the simulation, and whether two identical runs agree.

## In CI

`oodle init --ci` writes `.github/workflows/oodle.yml`. On every pull request, Oodle comments one outcome diff and fails the check only when something blocks. The pull request that adds Oodle passes: the base promised nothing yet, so every outcome is `new`.

When a change to a promise is intended (a new field in a confirmation, a price that really did change), the comment ends with a line like:

```
/oodle approve checkout.payment-confirmed@1a2b3c4d
```

A maintainer other than the author submits a review containing it, and the check re-runs green, with the change marked approved and by whom. The approval covers that change exactly as it is. If a later push changes it, it needs approving again. A broken outcome is never approvable: fix the code, or redefine the outcome and approve that. See [`docs/cli.md`](docs/cli.md#ci) and [0007](docs/decisions/0007-approvals-in-ci.md).

## The CLI

```
oodle run [project]            Run every outcome and behavior under every condition
oodle check [project]          Outcome diff of the working tree against a git ref
oodle diff <base> <head>       Outcome diff between two project checkouts
oodle lint [project]           Validate the catalog and its traceability
oodle init [dir]               Start a project: wraps the service already here, or a starter app
oodle doctor [project]         Check your environment and project setup
oodle mutate [project]         Plant small bugs and see which ones the catalog catches
oodle propose <file>           Add drafted entries as proposals, never changing an existing one
oodle draft <brief>            Print the prompt that drafts catalog entries from a brief
oodle mcp [project]            Serve Oodle to coding agents over MCP
oodle hook <event>             Answer a coding agent's hook (Claude Code)
oodle completion <shell>       Print a bash, zsh or fish completion script
```

- **Finds the project.** Run it from anywhere inside a project, and it walks up to the nearest `oodlc/` folder.
- **Readable in a terminal, clean in a pipe.** Results go to stdout; Oodle, progress, hints and errors go to stderr. Colour follows `NO_COLOR`, `FORCE_COLOR` and `--color`.
- **Made for scripts and agents.** `--json` (or `OODLE_FORMAT=json`) prints exactly one JSON document, errors included. `oodle help --json` describes the whole CLI.
- **Helps you get unstuck.** Every error says what to do next, typos get a "did you mean", and each run ends with a suggested next step.
- **Fits the inner loop.** `oodle run --watch --only "checkout.*"` re-runs one slice on every save.
- **Native in CI.** `uses: oodlc/oodle@v0` keeps one outcome-diff comment updated on every pull request, and takes approvals from reviews. Findings become annotations and the diff goes to the job summary.
- **Predictable exit codes.** `0` ok, `1` blocking, `2` could not run, `130` interrupted. Ctrl-C cleans up after itself.

The full reference is in [`docs/cli.md`](docs/cli.md).

## For coding agents

```
/plugin marketplace add oodlc/oodle
/plugin install oodle@oodlc
```

The Claude Code plugin tells the agent how the project is guarded. It asks you before the agent touches an approved outcome or constraint, and it keeps the agent working while an outcome it broke is still broken. It also adds the Oodle MCP tools. Agents **propose** outcomes (`status: proposed` runs and reports but never blocks), and you approve them by deleting one line. `oodle mutate` shows which planted bugs your outcomes miss, and with `--tests` which unit tests they already cover. See [`docs/agents.md`](docs/agents.md).

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
- **`when`** gives a condition its own expectations. Each field it names replaces that field of `expect`, e.g. `when: { security.no-credentials: { status: 401 } }`. `status` also takes a matcher such as `{ gte: 400, lte: 499 }`. See [0004](docs/decisions/0004-conditions-carry-expectations.md).
- **The security pack** is a set of built-in conditions that need no app knowledge: `security.no-credentials`, `security.injection`, `security.oversize`, `security.extra-fields` (mass assignment and `__proto__` pollution) and `security.replayed`. `given` also takes `headers`, `repeat` and `fuzz`, and constraints see the `request`. `probe: { conditions: [...] }` in `oodlc/config.yaml` probes every unknown route with them.
- **The simulation is sealed.** Reaching the real network instead of going through `ctx.effects` is an `oodle.sealed` violation and blocks. `sealed: { allow: [host] }` lets named hosts through. See [0005](docs/decisions/0005-sealed-simulation.md).
- **`status: proposed`** on an intent, outcome or constraint means it runs and is reported, but never blocks until a human deletes that line. `oodle propose` writes proposals, and only proposals. See [0006](docs/decisions/0006-proposals-and-propose-only-agents.md).

Full schema: [`spec/catalog.schema.json`](spec/catalog.schema.json).

## The app contract

```ts
import type { CreateApp } from 'oodle/contract';

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
| Checkout without credentials still charges (`when` says 401) | outcome broken under `security.no-credentials` |
| Checkout trusts a `total_cents` from the body | outcome broken under `security.extra-fields` |
| The same request sent twice charges twice | `charge-once` violated under `security.replayed` |
| A new route charges without credentials | blocking under `probe.conditions` |
| A route merges a body's `__proto__` into an object | `oodle.prototype-pollution` violated |
| The health check calls `fetch` directly | `oodle.sealed` violated, blocking |
| A proposed outcome does not hold yet | reported, nothing blocks |
| Marking an approved outcome `proposed` | `redefined`, blocking |
| Approve the `currency` change with its `id@fingerprint` | still `changed`, marked approved, nothing blocks |
| Approve it, then push a different `currency` value | approval stale, blocking again |
| Approve a broken outcome | never approvable, still blocking |
| The pull request that adds Oodle | every outcome `new`, nothing blocks if they hold |

## Not yet

Learned simulation models, probes against real environments, event and schedule triggers, multi-service systems, UI outcomes, and an OS-level sandbox for child processes.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Changes to what blocks a merge or what the catalog means need a [decision record](docs/decisions/).

## License

Apache-2.0
