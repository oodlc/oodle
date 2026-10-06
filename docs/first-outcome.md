# Your first outcome in 5 minutes

You have an HTTP service (Express, Fastify, Koa, Hono, `node:http` or Next.js). By the end of this page, one thing it promises its callers is protected: if a change breaks it, Oodle blocks the merge.

You need Node 20.11 or newer. Nothing else here needs the concepts. Those can wait until [day two](#day-two).

## 1. Install and init (1 minute)

```bash
npm i -D @oodlc/oodle
npx oodle init
```

On pnpm, yarn or bun, install with that tool (`pnpm add -D @oodlc/oodle`, then `pnpm exec oodle init`).

`init` reads your service without changing it:

```
✔ Wrapped your service  express app in src/app.ts, run through oodle.app.ts

  Outbound calls, named under effects in oodle.app.ts and stubbed in oodlc/config.yaml:
  → api.sendgrid.com as sendgrid.request · src/payments.ts
  → api.stripe.com as stripe.request · package.json (stripe), src/payments.ts

  A first catalog, from probing each route:
  + outcome    post-orders
  + outcome    post-orders-id-refund
```

- **It finds the app.** When `src/server.ts` only calls `app.listen()`, `init` follows the import to the module that builds the app.
- **It names the outbound calls.** It looks for URLs in your code and SDKs like `stripe` in `package.json`, lists each host under `effects` in `oodle.app.ts`, and gives each one a placeholder stub in `oodlc/config.yaml`. Oodle runs your app in a sealed simulation, so these stubs answer instead of the real APIs.
- **It finds your database.** If the service uses Postgres (`pg`, `postgres`, Prisma's pg adapter), `init` adds `database:` to `oodlc/config.yaml`, pointed at your migrations. Oodle runs a real Postgres in process for every run, so install it once: `npm i -D @electric-sql/pglite`. See [A real database](../README.md#a-real-database).
- **It writes a first catalog.** It sends a request to each route in the simulation and saves what came back as a proposed outcome in `oodlc/proposed.yaml`. A proposal runs and is reported, but blocks nothing until you approve it.

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

## 3. Make one proposal a promise (2 minutes)

Open `oodlc/proposed.yaml`. Each entry is what a route did when Oodle called it:

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

Pick the one that would hurt most to break. Say what it promises, in words a customer would recognise, and delete the `status: proposed` line:

```yaml
  - id: orders.empty-cart-rejected
    intent: service-available
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

Move it into `oodlc/outcomes.yaml` if you like. Any `.yaml` file in `oodlc/` works. Delete the proposals you don't want.

## 4. Run it (30 seconds)

```bash
npx oodle run
```

```
Outcomes  declared · blocking
  ✔ service.reachable           external   2ms
  ✔ orders.empty-cart-rejected  customer   4ms
```

`service.reachable` is the starter outcome for `GET /health`, written by `init` because your service has one.

Now break it on purpose: change `empty_cart` to `cart_empty` in the code and run again. Oodle names what broke and exits with `1`. Change it back.

When a run fails, the first line under the outcome is the cause. A call with no stub reads `no stub for external call "stripe.request"`, not just `status: expected 201, got 500`.

## 5. Put it in CI (30 seconds)

```bash
npx oodle init --ci
```

In a project that already has `oodlc/`, this writes only `.github/workflows/oodle.yml`. Commit it with your outcome. From now on, every pull request gets an outcome diff, and one that breaks `orders.empty-cart-rejected` can't merge.

## Day two

Once one outcome holds, add the rest as you need them:

- **Data to start from.** With a database, list the rows each outcome needs under `given.db`, and expect the writes that matter, e.g. `{ kind: db.orders.inserted, count: 1 }`.
- **Real stub answers.** Replace each `{ result: {} }` with what the API actually returns, so routes that call Stripe or SendGrid get past the call.
- **More outcomes.** `npx oodle propose --routes` proposes one for each route nothing describes yet. `npx oodle draft brief.md` writes a prompt that turns a PRD or ticket into proposals.
- **Conditions**: the same promise under a slow provider, a returning customer, or no credentials.
- **Constraints**: invariants that must hold on every run, like "never charge without an order".
- **The security pack**: built-in conditions for missing credentials, injection, oversize bodies, mass assignment and replays.
- **Approvals**: how a reviewer approves an intended change to a promise on a pull request.

All of it is in the [README](../README.md#day-two).
