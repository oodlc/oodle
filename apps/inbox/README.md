# @oodle/inbox

The remote inbox (section 10 of [the implementation guide](../../docs/implementation-guide.md)): one Cloudflare Worker that holds the questions Oodle asks people, and their answers.

- **`/api/v1/*`** for the `oodle` CLI, with a project token. The CLI pushes gaps and intents and pulls answers and approvals.
- **`/api/ui/*`** for people, behind Cloudflare Access. People answer gaps and review intents.
- **`/app/*`** the web app (React, Vite), served as static assets.

The inbox only records answers. The CLI applies them to the spec in git (`oodle sync`), which stays the only source of truth. There is no code view anywhere.

Decisions: [0030](../../docs/decisions/0030-the-inbox-runs-as-one-worker.md) (build, serving, seeding) and [0031](../../docs/decisions/0031-what-the-inbox-accepts-and-who-wins.md) (what tokens may do, conflicts).

## Layout

```
src/worker/     Hono app: sync.ts (/api/v1), ui.ts (/api/ui), auth.ts (tokens, Access), db.ts
src/shared/     protocol.ts (wire types, shared with the CLI), seed.ts (bootstrap SQL)
src/web/        React app: Inbox, Gap, Intent review, Activity, People and tokens
migrations/     D1 schema
scripts/seed.ts create a project, its first owner and a first token
test/           Worker tests (workerd + D1) and UI helper tests; fixtures/dogwalk-gaps.json
```

## Local development

```sh
cp .dev.vars.example .dev.vars        # DEV_AUTH=1 and DEV_EMAIL=you@example.com
pnpm --filter @oodle/inbox seed:dev   # local D1: migrations, project "dogwalk", you as owner, demo gaps; prints a token
pnpm --filter @oodle/inbox dev        # builds the app, runs wrangler dev on :8787
```

Open http://localhost:8787/app/. With `DEV_AUTH=1`, the Worker takes your identity from the `X-Oodle-Dev-Email` header, or from `DEV_EMAIL` when there is none (to act as someone else from the browser, set `localStorage['oodle.devEmail']`). `DEV_AUTH` must never be set in `wrangler.jsonc`; a test checks.

For hot reload of the web app, run `pnpm dev:web` alongside `wrangler dev` (Vite on :5173/app/, `/api` proxied to :8787).

Point the CLI at it: `remote: { url: http://localhost:8787, project: dogwalk }` in `oodle.config.yaml`, and `OODLE_TOKEN=<the printed token>`.

## Tests and build

```sh
pnpm --filter @oodle/inbox test       # vitest in workerd (@cloudflare/vitest-plugin), D1 migrations applied
pnpm --filter @oodle/inbox build      # vite build + typecheck (no network, no Cloudflare credentials)
```

## Deploy

1. **D1**: `pnpm exec wrangler d1 create oodle-inbox`, then put the printed `database_id` in `wrangler.jsonc`.
2. **Cloudflare Access** (Zero Trust → Access → Applications → self-hosted), for the inbox's hostname:
   - one application covering `/app` and `/api/ui`, with a policy for the people who may use the inbox;
   - a **Bypass** policy (or a separate application) for `/api/v1`, which the CLI reaches with project tokens, not Access.

   Put your team domain (`<team>.cloudflareaccess.com`) in `ACCESS_TEAM_DOMAIN` and the application's audience tag in `ACCESS_AUD` (`wrangler.jsonc` vars). The Worker checks the `Cf-Access-Jwt-Assertion` signature against `https://<team>/cdn-cgi/access/certs`, the audience and the issuer, on every `/api/ui` request.
3. **Deploy**: `pnpm --filter @oodle/inbox deploy` (builds the app, applies migrations remotely, `wrangler deploy`).
4. **Seed the first project**:

   ```sh
   node scripts/seed.ts --remote --project dogwalk --name "Dog walks" --owner you@example.com
   ```

   It prints a project token once; only its SHA-256 hash is stored. The owner can then add people and tokens from the app (People and tokens). `--print` prints the SQL instead, for `wrangler d1 execute oodle-inbox --remote --file=…`.

## API

All bodies are JSON; types are in [`src/shared/protocol.ts`](src/shared/protocol.ts). Errors are `{ error, message }`, plus the current `gap` or `intent` on 409.

### CLI (`Authorization: Bearer <project token>`)

| | |
| --- | --- |
| `POST /api/v1/projects/:project/sync` | Push gaps, intents, applied acks and superseded gaps; get answers and approvals with `seq > cursor`, in seq order, and the new cursor. |

Push rules: an unchanged `content_hash` touches nothing. A changed open gap gets the new body. A changed gap that has an answer here reopens, keeps the answer, and says the evidence changed. Agent gaps that arrive settled are stored `applied`. A human gap that arrives with an answer not given by a person is refused (403) and nothing in the push is written. `applied` acks set `applied_sha` and `acked_at` and mark the gap `applied`. Superseded gaps that were not applied become `superseded`.

### People (Cloudflare Access; roles `owner` > `answerer` > `viewer`)

| | Role | |
| --- | --- | --- |
| `GET /api/ui/projects` | member | Your projects, with open counts |
| `GET /api/ui/projects/:p/gaps?status=&route=&intent=&conflicts=open` | viewer | |
| `GET /api/ui/projects/:p/gaps/:id` | viewer | The gap, its answers and conflicts |
| `POST /api/ui/projects/:p/gaps/:id/answer` | answerer | `{ option } \| { text, target } \| { dont_care: true } \| { dismiss: true }`, plus `version`. 201, or 409 on a stale version or a conflict |
| `POST /api/ui/projects/:p/gaps/:id/conflicts/:cid/resolve` | standing answerer or owner | `{ resolution: "keep" \| "take" }` |
| `GET /api/ui/projects/:p/intents?status=in_review` | viewer | |
| `GET /api/ui/projects/:p/intents/:id` | viewer | The intent, its reviews (stale ones marked), the gaps it raised |
| `POST /api/ui/projects/:p/intents/:id/review` | answerer | `{ decision, note, content_hash }`. 409 if the content changed, or (approve) if a raised gap is open |
| `GET /api/ui/projects/:p/activity?type=&actor=&limit=` | viewer | The event log, newest first |
| `GET/POST /api/ui/projects/:p/members` | viewer / owner | List; add or change a member |
| `GET/POST /api/ui/projects/:p/tokens`, `DELETE …/tokens/:id` | owner | List, create (returned once), revoke |

A request to `/api/ui` that carries a project token gets 403: tokens never answer or approve. Every write goes to the event log.
