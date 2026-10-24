# 0030. The inbox runs as one Worker: plain Vite assets, a small router, seeding by SQL

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

Section 10 of the implementation guide sketches the inbox: one Worker with Hono and D1, the web app as static assets under `/app/*`, Cloudflare Access in front of people's routes, and tests with `@cloudflare/vitest-pool-workers`. It leaves open how the web app is built and served, which test package to use now, and how the first project, owner and token come to exist when nobody can sign in to the UI yet.

Facts at the time of writing:

- `@cloudflare/vitest-pool-workers` is deprecated, renamed to `@cloudflare/vitest-plugin` (1.4.7). The old package needs vitest 4; the new one accepts vitest 5, which the workspace uses.
- The Cloudflare Vite plugin builds the Worker too and wants to own the dev server. The Worker here needs no bundling help from Vite.
- With `not_found_handling: "single-page-application"`, the fallback is the root `index.html`. The app lives under `/app/`, not at the root.
- `pnpm -r build` must not need a network or Cloudflare credentials.

## Decision

1. **Plain Vite for the web app**, built to `dist/web/app` with base `/app/`. Wrangler serves `dist/web` as assets with `not_found_handling: "none"` and `run_worker_first: ["/api/*"]`. Files that exist are served directly; anything else under `/app/` reaches the Worker, which answers with `/app/` (the index). `/` redirects to `/app/`.
2. **Tests use `@cloudflare/vitest-plugin`** with the workspace's vitest 5. They run in workerd against the real D1 binding, with `migrations/` applied by a setup file. Tests call the Hono app directly, so each can pass its own env (for `DEV_AUTH`, a fake `ASSETS`) and the JWKS fetch can be stubbed on `globalThis.fetch`. Every test makes its own project, so tests don't depend on storage isolation between them.
3. **A history-API router of about 30 lines** instead of a routing library. Four screens and a settings page don't need more. Route matching is a pure function, tested with the rest.
4. **Bootstrap by SQL, not by an API.** `scripts/seed.ts` builds the statements (project, first owner, first token, stored as a hash) and runs them with `wrangler d1 execute --local|--remote`; `--print` only prints them. The same function builds the test fixtures' projects, so the tests run the seed. After that, owners add people and tokens in the UI (`/api/ui/projects/:p/members`, `/tokens`).
5. **Dev identity**: with `DEV_AUTH=1` (only in `.dev.vars`), the Worker takes `X-Oodle-Dev-Email`, or `DEV_EMAIL` when there is no header, so a browser on `wrangler dev` works without Access. A test reads `wrangler.jsonc` and fails if `DEV_AUTH` or `DEV_EMAIL` appears in it.

## Options considered

### A. The Cloudflare Vite plugin for the whole app

- Good: one dev server, Worker and app hot-reload together.
- Bad: couples the Worker build to Vite, and `vite build` then prepares a deploy config. More moving parts for a Worker that is a plain Hono app.

### B. SPA fallback by wrangler (`single-page-application`)

- Good: no Worker code for it.
- Bad: falls back to the root index, so the app would have to live at `/` or be built twice. Answering from the Worker is three lines.

### C. An owner-only `POST /api/ui/projects`

- Good: no script.
- Bad: someone has to be an owner somewhere first, so it still needs SQL for the very first project. One path is simpler than two.

## Consequences

- `pnpm build` is `vite build` plus four `tsc` runs (worker, web, tests, scripts); nothing touches Cloudflare.
- `pnpm dev` builds the app once and runs `wrangler dev`; `pnpm dev:web` runs Vite with `/api` proxied to `wrangler dev` for hot reload.
- The web app has no routing library to upgrade, and no deep links beyond what `matchRoute` knows.

## Revisit if

- The app grows past a handful of screens or needs nested layouts and loaders: take a router.
- Live updates become a requirement (guide 10.1): add a Durable Object per project and record it.
- `@cloudflare/vitest-plugin` changes how bindings or migrations are provided.
