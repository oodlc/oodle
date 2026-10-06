# 0008. Next.js route handlers run through Next's own route module

- **Status:** Proposed
- **Date:** 2026-10-06
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0005. The simulation is sealed](0005-sealed-simulation.md)

## Context

Oodle runs an existing service in process through `httpApp`, which drives anything with a `fetch(Request)` method. A Next.js App Router app has no such object. Its HTTP surface is a tree of `app/**/route.ts` files, each exporting `GET`, `POST` and so on, behind an optional `middleware.ts`. Next builds the router, the request scope and the middleware wiring itself, at build time and in its server.

Route handlers take a standard `Request` and return a `Response`, so calling them looks easy. But real handlers call `cookies()` and `headers()` from `next/headers`, which throw outside Next's request scope. `redirect()` and `notFound()` throw special errors that Next turns into responses. `params` is a promise Next builds. `revalidatePath()` needs Next's work store. In the first real app tried (273 route files), 57 files import `next/headers` or `next/navigation` directly, and many more routes reach `cookies()` through a shared helper such as Supabase's server client.

Next has no public API for running one route handler outside its server. The pieces that do it, `AppRouteRouteModule` and the async storages it sets up, are internal and changed shape between 15 and 16.

## Decision

1. **`@oodlc/oodle/next` exports `nextApp({ dir, effects, setup })`**, which finds the route files and middleware from the file tree and gives `httpApp` a `fetch` handler. Effects, the seal and determinism come from `httpApp` unchanged.
2. **Each handler runs inside Next's own `AppRouteRouteModule`**, loaded from the project's `next` package, so `cookies()`, `headers()`, `redirect()`, `notFound()`, `dynamic` and 405s are Next's behavior, not a copy of it.
3. **All contact with Next internals stays in `src/next.ts`.** Supported majors are listed there (15 and 16). Any other version fails with a message naming the supported ones. CI runs the fixture app on both.
4. **The middleware runs first** when its `matcher` applies (compiled by Next's own matcher code), and its `next()`, `rewrite()` and request-header changes carry on as in Next.
5. **An uncaught error is a 500**, as in a Next production server, with its message kept as the internal effect `internal.next.error`.
6. **The environment is Next's test mode:** `.env.test.local`, `.env.test` and `.env`, never `.env.local`, so runs don't depend on one developer's machine.
7. **Pages, server components, server actions and `pages/api` are out of scope.** Outcomes are about what a caller gets over HTTP, and route handlers are that surface.

## Options considered

### A. Call the exported handlers directly, and shim `next/headers`, `next/navigation` and `next/cache`

- Good: no Next internals. Works on any version where handlers are functions of a `Request`.
- Bad: a second implementation of Next's request scope that drifts from the real one. Every shim is a place where Oodle's answer and production's differ, which is the one thing an outcome diff can't afford.

### B. Build the app with `next build` and drive the production server

- Good: exactly production.
- Bad: a build per run is minutes, not milliseconds, on every pull request and both sides of `oodle check`. Next's server also patches `fetch` for its data cache, which fights the effects and the seal.

### C. Drive Next's route module in process (chosen)

- Good: Next's own semantics for everything a handler can call, at in-process speed (about 1ms per request on the fixture).
- Bad: internal API. A Next major can break it, and supporting one means reading its route module.

## Consequences

- A Next app is adopted with `oodle init`, like an Express one.
- Each new Next major needs a look at `AppRouteRouteModule`'s constructor and `handle()` context before it's added to the supported list. The fixture tests catch breakage in minors.
- Oodle's dev dependencies include Next 15 (as `next15`) and 16, for the tests. Users don't install anything new.
- Apps that reach their database over HTTP (Supabase) name it under `effects` like any other host. Until they do, the seal refuses those calls, and clients that retry on network errors make the run slow before it reports them.

## Revisit if

- Next ships a public API for running a route handler in a test, which would replace the internal one.
- A Next major changes the route module so much that supporting both means two implementations.
- Users need pages or server actions in outcomes.
