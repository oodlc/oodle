# 0016. Outcomes check headers and text, set the host, and cite outside specs

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0004. Conditions carry expectations](0004-conditions-carry-expectations.md)

## Context

A review of Oodle on a Cloudflare Worker (a site with an admin area, an MCP endpoint and public pages) found promises an outcome couldn't state:

- "A logged-out visitor to /admin is redirected to the login page." The status was checkable; the `location` header wasn't. Cookies weren't either. The adapter already captured response headers; `expect` had nowhere to put them.
- "No queued, draft or killed card shows on public pages." The pages are HTML. `body` takes field paths into a JSON body, so a string body could only be matched whole, and `contains` had no negative.
- "The engine host answers for itself." The adapter always built the request URL as `http://localhost`, so a fetch-style app (a Worker, Hono, Next.js) that reads its host from `request.url` never saw another one, whatever `given.headers.host` said.
- The project already had a spec of approved behaviors (B-041, B-064, …). Outcomes restated them, and the ids had to go into the statement text.

## Decision

1. **`expect.headers`**: response headers by name, matched case-insensitively, each an exact string or a matcher. `{ exists: false }` says a header is absent.
2. **`expect.text`**: the whole body as text, an exact string or a matcher. A string body is the text; anything else is its JSON.
3. **Two matchers.** `not_contains` (a string or a list) is the negative of `contains`, which also takes a list. `not` holds when the value it wraps doesn't match. An absent value contains nothing, so `not_contains` holds on it.
4. **Constraints see `response.headers`.**
5. **The request host comes from `given.headers.host`**, and the scheme is `https` when `x-forwarded-proto: https`, for every fetch-style app. Node handlers already read the `host` header.
6. **`refs`** on outcomes, behaviors and constraints: ids in a spec kept outside the catalog. They're shown in the run output and the outcome diff. They're traceability only, so they aren't part of an outcome's definition, and editing them changes no promise.
7. **Amendments** (0012) merge `headers` by name, like body fields, and replace `text`.

Headers are checked, not kept. A run's report and a behavior's `observed` snapshot stay status, body and effects, because headers carry dates, request ids and cache tokens that would show as drift on every pull request.

## Options considered

### A. Let `body` be a matcher when the body is a string

- Good: no new field.
- Bad: `body: { contains: x }` already means "the field `contains` equals x" in a JSON body. One key, two readings.

### B. `text` beside `body` (chosen)

- Good: one reading each. `body` is fields, `text` is the whole thing, and both can be set.
- Bad: two places to look for a body expectation.

### C. A general `not` only, with no `not_contains`

- Good: one negative.
- Bad: `{ not: { contains: queued } }` is the common case and reads worse, and a list of forbidden words needs one `not` each. Both are kept.

### D. Record headers in every observation

- Good: header drift shows on behaviors.
- Bad: noise from dates and ids on every run. A header someone cares about belongs in an outcome.

## Consequences

- Redirects, cookies, content types, cache rules, and the absence of leaked content on HTML pages can be promised.
- A Worker or a multi-host app can be tested per host.
- A catalog that restates another spec keeps the link in data, not prose.
- `text` on a large page fails with an excerpt around what it found, not the whole page.

## Revisit if

- A promise needs header drift on behaviors.
- HTML needs structure, not text: "the nav has five links". That needs a selector matcher, which is a bigger step.
