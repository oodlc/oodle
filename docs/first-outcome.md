# Your first outcome in 5 minutes

You have an HTTP service (Express, Fastify, Koa, Hono, `node:http` or Next.js). By the end of this page, one thing it does is written down, one promise about it is protected, and you know how to change that promise without a fight in code review. If a change breaks it, Oodle blocks the merge.

Three ideas carry the whole page:

- A **capability** says what your system lets someone do: "a shopper can pay for a cart and get one receipt".
- An **outcome** protects a capability: a request, and what must come back. If it stops holding, the merge is blocked.
- A **change** says what's about to change, and why, before the code does. A pull request that does exactly that goes through.

You need Node 20.11 or newer. Everything else can wait until [you need it](#when-you-need-them).

## 1. Install and init (1 minute)

```bash
npm i -D @oodlc/oodle
npx oodle init
```

On pnpm, yarn or bun, install with that tool (`pnpm add -D @oodlc/oodle`, then `pnpm exec oodle init`).

`init` reads your service without changing it:

```
✔ Wrapped your service  express app in src/server.ts, run through oodle.app.ts

  Outbound calls, named under effects in oodle.app.ts and stubbed in oodlc/config.yaml:
  → api.sendgrid.com as sendgrid.request · src/payments.ts
  → api.stripe.com as stripe.request · src/payments.ts

  A first catalog, from probing each route:
  + outcome    post-orders
  + outcome    post-orders-id-refund
```

- **It finds the app.** When `src/server.ts` only calls `app.listen()`, `init` follows the import to the module that builds the app.
- **It names the outbound calls.** It looks for URLs in your code and SDKs like `stripe` in `package.json`, lists each host under `effects` in `oodle.app.ts`, and gives each one a placeholder stub in `oodlc/config.yaml`. Oodle runs your app in a sealed simulation, so these stubs answer instead of the real APIs.
- **It finds your database.** If the service uses Postgres (`pg`, `postgres`, Prisma's pg adapter), `init` adds `database:` to `oodlc/config.yaml`, pointed at your migrations. Oodle runs a real Postgres in process for every run, so install it once: `npm i -D @electric-sql/pglite`. See [A real database](../README.md#a-real-database).
- **It drafts outcomes.** It sends a request to each route in the simulation and saves what came back as a proposed outcome in `oodlc/proposed.yaml`. A proposal runs and is reported, but blocks nothing until you approve it.

## 2. Check the wiring (1 minute)

```bash
npx oodle doctor
```

Each problem comes with its fix. The usual ones on day one, from `init` or `doctor`:

| Oodle says | do this |
| --- | --- |
| `src/server.ts calls listen() on import. Guard it` | Only listen when run directly: `if (import.meta.main) app.listen(port)`, or `if (require.main === module)` in CommonJS. Then `npx oodle propose --routes` writes the proposals `init` couldn't. |
| `no stub for stripe.request, named in oodle.app.ts` | Add it under `defaults.given.stubs` in `oodlc/config.yaml`. |
| `reaches the real network: api.example.com:443` | Add the host under `effects` in `oodle.app.ts`, then stub that effect. |
| `reaches the real network: localhost:5432` | That's Postgres: add `database: { schema: db/migrations }` (your migrations folder) to `oodlc/config.yaml`. |
| `given.db.ordrs: no such table; did you mean orders?` | Fix the table name in `given.db`. Each run starts from the rows it lists. |

When it ends with `✔ Ready`, Oodle is running your code.

## 3. Describe a capability (1 minute)

```bash
npx oodle discover
```

```
  + capability health.read        GET /health · service-available
  + capability orders.create      POST /orders
  + capability orders.refund      POST /orders/:id/refund

  Could name their capability  add capability: <id> to each; it changes no promise
    orders.create      post-orders
```

`discover` groups your routes by what they act on and what they do to it, and adds each group to `oodlc/proposed.yaml` as a proposed capability. Each one comes with its evidence: what Oodle saw (`observed`) and what someone wrote (`inferred`).

```yaml
  - id: orders.create
    statement: 'TODO: who can do what through POST /orders? Say it as "<actor> can <verb> <object>".'
    surfaces:
      - POST /orders
    evidence:
      - text: "POST /orders: served by the app"
        grade: observed
      - text: "POST /orders: described by outcome post-orders"
        grade: inferred
    status: proposed
```

Pick the one that matters most. Say what it lets someone do, as "<actor> can <verb> <object>", and delete the `status: proposed` line. That confirms it:

```yaml
  - id: orders.create
    statement: A shopper can pay for a cart and get one receipt
    surfaces:
      - POST /orders
    evidence:
      # …as discover wrote it
```

Not sure what to write? `npx oodle interview` asks you, one capability at a time, and writes your answers in.

## 4. Protect it with an outcome (1 minute)

Back in `oodlc/proposed.yaml`, find the outcome `init` drafted for the same route. `discover` named it under "Could name their capability":

```yaml
  - id: post-orders
    intent: service-available
    statement: "TODO: say what a caller can count on. Observed: POST /orders answered 400"
    boundary: external
    trigger:
      http: POST /orders
      given:
        body: {}
    expect:
      status: 400
      body:
        error: empty_cart
    status: proposed
```

Say what it promises, in words a customer would recognise. Point it at the capability it protects, and delete the `status: proposed` line. (No outcome drafted for your capability's route? `npx oodle propose --capabilities` drafts one from the capability's words and what Oodle saw the route do.)

```yaml
  - id: orders.empty-cart-rejected
    capability: orders.create
    statement: An order with nothing in it is refused with a clear error, and nobody is charged
    boundary: customer
    trigger:
      http: POST /orders
      given:
        body: {}
    expect:
      status: 400
      body:
        error: empty_cart
```

Move it into `oodlc/orders.yaml` if you like. Any `.yaml` file in `oodlc/` works. Delete the proposals you don't want.

Then run it:

```bash
npx oodle run
```

```
Outcomes  declared · blocking
  ✔ orders.empty-cart-rejected  customer   6ms
  ✔ service.reachable           external   0ms
```

`service.reachable` is the starter outcome for `GET /health`, written by `init` because your service has one.

Now break it on purpose: change `empty_cart` to `cart_empty` in the code and run again. Oodle names what broke and exits with `1`. Change it back.

When a run fails, the first line under the outcome is the cause. A call with no stub reads `no stub for external call "stripe.request"`, not just `status: expected 201, got 500`.

## 5. Put it in CI (30 seconds)

```bash
npx oodle init --ci
```

In a project that already has `oodlc/`, this writes only `.github/workflows/oodle.yml`. Commit it with your capability and outcome. From now on, every pull request gets an outcome diff, and one that breaks `orders.empty-cart-rejected` can't merge.

## 6. Change it through a change file (when you first need to)

Say the shop wants the error to tell shoppers what to do. That changes a promise, so agree it first, in its own small pull request:

```yaml
# oodlc/changes/explain-empty-cart.yaml
changes:
  - id: explain-empty-cart
    because: The shop shows our error to shoppers, and "empty_cart" alone doesn't tell them what to do next
    reaches: [orders.create]                     # the capabilities it may touch
    amends:
      - outcome: orders.empty-cart-rejected
        expect:
          body:
            message: { exists: true }
    rules_out: [new effects, new hosts, new routes, new dependencies]
```

Review and merge that. Then write the code, yourself or with an agent (`npx oodle changes brief explain-empty-cart` is its brief). On that pull request, `oodle check` covers what the change says, so nothing blocks:

```
| 🟡 changed ✅ covered by `explain-empty-cart` | `orders.empty-cart-rejected` | customer | body.message added |
```

Anything that moves outside `orders.create`, or anything the change rules out, blocks as outside intent. Once it ships, `npx oodle changes fold explain-empty-cart` writes the new expectation into the outcome and archives the change.

## When you need them

The three ideas above are enough to start. The rest are there when a capability or an outcome needs more:

- **Intents**: why the product exists. An outcome or capability can name the intent it serves.
- **Behaviors**: what Oodle saw a route do that nobody promised. Reported when it drifts, never blocking.
- **Conditions**: the same outcome under a slow provider, a returning customer, or no credentials. The built-in security pack covers missing credentials, injection, oversize bodies, mass assignment and replays.
- **Constraints**: rules that hold on every run, like "never charge without an order".
- **Actors**: who uses the system: shoppers, operators, a partner's server.
- **Experiences**: what someone goes through across capabilities, and what would make it feel broken.
- **Questions**: what the system can't answer about itself, and who can. `discover` and `interview` raise them.
- **Terms**: what words like "order" or "paid" mean here.

Also worth knowing: `npx oodle explain` maps every capability and what protects it, `npx oodle propose --routes` drafts outcomes for routes added later, `npx oodle mutate` plants small bugs and lists the ones no outcome caught, and a reviewer can approve a changed promise in review without a change file.

All of it is in the [README](../README.md#day-two).
