# 0015. Stubs and request bodies are proposed from traffic, scrubbed, and accepted by a person

- **Status:** Proposed (approved in review; implemented in 0.16.0)
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Builds on:** [0006. Proposals](0006-proposals-and-propose-only-agents.md), [0014. Evidence grades](0014-evidence-grades.md)

## Context

`oodle init` gives every outbound call a placeholder stub (`{ result: {} }`) in `oodlc/config.yaml`, and `oodle propose --routes` probes each route with an empty body. So a route that charges a card or takes an order usually fails at its first line in the simulation, and the proposed outcome describes that failure. People then write stub results and bodies by hand, from API docs or memory.

A capture of real traffic already holds both: what Stripe or SendGrid answered (when the capture saw the service's outbound calls), and what callers sent. `oodle discover --from` reads HAR and OTLP files today, but only methods, paths, times and pages: no headers, no bodies.

Three things make this more than a reader:

- **Stubs aren't catalog.** They live in `oodlc/config.yaml` under `defaults.given.stubs`, which every run reads. Nothing proposes into config today, and a stub changes what every outcome sees.
- **Captures are full of personal data and secrets**: tokens in headers, cookies, card numbers and emails in bodies, tokens in paths and query strings. 0.11 to 0.15 already write concrete captured paths into `proposed.yaml`: the `unrouted.<file>` question lists them as seen (`GET /password-reset/eyJhbGciOi…`, `GET /users/ada.lovelace@example.com/orders`). That is a leak today, and this design fixes it.
- **A browser HAR only sees the service from outside.** Outbound calls show up in a HAR recorded at the service's egress (a proxy in front of its outbound traffic) or in OTLP client spans. OTLP spans carry status and timing, not bodies.

## Decision

1. **What is read.**
   - *Outbound calls:* HAR entries and OTLP client spans (kind 3) whose method and URL match one of the app's own `effects` rules. Oodle classifies them exactly as the adapter does at run time: `httpApp` and `nextApp` expose their rules to the runner. Hosts that match no rule are listed as candidates for `effects`, never stubbed. Apps on the raw contract (`ctx.effects.call` with no URL rules) get nothing: there is no URL to match.
   - *Per effect kind:* how many calls, by status; the median latency (HAR `time`, or span end minus start); and, from HAR only, the response body of the most common success status. OTLP proposals carry status and latency, and say there was no body to read.
   - *Inbound requests:* for each route, the body of the first request that got a 2xx (else the first seen), from HAR. OTLP carries no bodies.
2. **What is proposed.**
   - `oodle propose --stubs --from <file>` proposes one stub per effect kind: `result` (the scrubbed body, `$status` when it isn't 2xx) and `latency_ms`, with graded evidence and the file's scope. Each other status seen becomes a proposed condition, `observed.<kind>-<status>`, with that stub, inert until an outcome lists it (402 seen 3 times is a declined card).
   - `oodle propose --routes --from <file>` probes each route nothing describes with the captured body instead of `{}`, and the proposed outcome's `given.body` is that body. Propose stays add-only (0006): outcomes already proposed are not rewritten.
   - MCP: the `propose` tool takes `draft: stubs` with `from`, and `from` with `draft: routes`, returning the CLI's JSON. The skill says when to use them.
3. **Where stub proposals go: a `proposed` section in `oodlc/config.yaml`**, beside what they would become:

   ```yaml
   defaults:
     given:
       stubs:
         payment.charge: { result: {} }                # init's placeholder
   proposed:                                          # never read by a run
     stubs:
       payment.charge:
         result: { id: ch_placeholder1, status: succeeded, amount: 1800, currency: usd }
         latency_ms: 180
         evidence:
           - { text: "seen 41 times in egress.har (2 h, 1,204 requests): 200 ×38, 402 ×3, median 180 ms", grade: observed }
   ```

   Runs never read `proposed`. A person accepts a stub by moving it into `defaults.given.stubs` (dropping `evidence`), one visible move in one file, as deleting `status: proposed` is for the catalog. Oodle writes only under `proposed`, in place, keeping comments, and never touches `defaults`. The Claude Code hook asks the person before an edit moves a proposed stub into `defaults`. `oodle doctor` lists the proposed stubs waiting and the placeholders they would replace. `spec/config.schema.json` gains `proposed.stubs`.
4. **Privacy is a hard requirement, with no way around it.**
   - One scrubber, in `src/evidence.ts`, runs as each file is read. Raw headers, bodies, paths and query strings never leave the reader: nothing else in Oodle can see them.
   - **Headers:** every header is dropped except `content-type`. That covers `Authorization`, `Cookie`, `Set-Cookie`, API keys and any custom token header, without a list to keep up to date.
   - **Query strings** are dropped. **Path segments** are templated (`/orders/:id`), and any segment that isn't a plain word becomes a parameter. This also fixes the `unrouted` leak above.
   - **Bodies** (JSON or form; anything else is dropped) keep their keys, numbers, booleans and nulls. A string is kept only when it looks like a code: lowercase, at most 32 characters, from `[a-z0-9_.:-]` (`succeeded`, `usd`, `card_declined`). Every other string is replaced with a placeholder chosen by what it looks like:
     - email: `person1@example.test`
     - card number (13 to 19 digits, Luhn-valid): Luhn-valid numbers from a fixed test range
     - phone number: `+15550100001`, from the reserved 555-01xx range
     - IP address: `192.0.2.1`, from TEST-NET
     - token (JWT shape, known prefixes such as `sk_`, `whsec_`, `ghp_`, `xox`, `AKIA`, or 20+ high-entropy characters): `token-1`, keeping a short id prefix such as `ch_` or `cus_` (`ch_placeholder1`)
     - a string under a name or address key (`name`, `first_name`, `last_name`, `email`, `phone`, `line1`, `postal_code`, …), and any other text: `text-1`

     Placeholders are numbered by first appearance in the file. The same value gets the same placeholder within a read, and the same file gives the same output every time. No hash of the real value is used: a hash of an email can be reversed by guessing.
   - **No flag, environment variable or MCP argument keeps real values.**
   - **A test proves it.** A fixture HAR full of fake secrets: a Bearer token, cookies, `Set-Cookie`, `sk_live_` keys, a JWT in a path, emails in a path, a query string and a body, card numbers, phone numbers, names under name keys and inside free text. Run `discover --from`, `propose --stubs --from` and `propose --routes --from` on it, through the CLI and through MCP. Then scan every file under the project, stdout, stderr, the JSON and the MCP replies for each secret. None may appear.
5. **Grades.** Everything read from traffic is observed evidence (0014), and the evidence on a proposed stub says so. A proposed stub, condition or outcome is still a proposal until a person accepts it: observed means Oodle saw it, not that anyone agreed to it.

Nothing here blocks. Proposed stubs never run. A proposed condition does nothing until an outcome lists it, and a proposed outcome never blocks.

## Options considered

### A. A proposed-stubs file merged by a person

- Good: config stays human-written only.
- Bad: 0003 makes every YAML file in `oodlc/` except `config.yaml` catalog, so it needs a second special name or a subfolder. Accepting is a move across files, and the proposal sits away from the placeholder it replaces.

### B. A printed patch

- Good: no new format, and nothing persists.
- Bad: nothing to review in a pull request until someone applies it, no list of what's waiting for `doctor` or an agent to read, and the evidence is gone once the terminal scrolls.

### C. Only proposed conditions carrying the observed stubs

- Good: all catalog, no config change.
- Bad: the defaults every run uses keep their placeholders, so routes that call out still fail until each outcome opts in.

### D. A `proposed` section in config, never run, accepted by a move (chosen)

- Good: the proposal sits beside the placeholder it replaces, accepting it is one move a reviewer can see, and the evidence travels with it.
- Bad: Oodle writes into a file people own, but only under `proposed`, and a test pins that it never touches anything else.

### Privacy: a denylist of headers and patterns, instead of keep-only-what-looks-safe

- Good: keeps more of the real shape.
- Bad: every missed pattern is a leak. Keep-only-what-looks-safe can only lose detail, and a stub needs structure and codes, not values.

## Consequences

- `spec/config.schema.json` gains `proposed.stubs`. `httpApp` and `nextApp` expose their effect rules to the runner.
- `discover` stops writing concrete captured paths. The `unrouted` question lists templated, scrubbed paths.
- Known limit: a lowercase single word under a key Oodle doesn't know as a name (`"customer": "ada"`) passes as a code. The fixture covers names under name keys and in free text. Teams with stricter needs can delete the capture once proposals are written: Oodle never keeps it.
- Known limit: OTLP-only projects get status and latency, not result shapes.

## Questions for review

1. `proposed:` in `config.yaml` (D), or a separate file (A)?
2. Should `propose --routes --from` refresh outcomes it proposed earlier with an empty body? This design says no (add-only, 0006).
3. Is keeping only code-like strings too aggressive for stub results that branch on free text (error messages)? The alternative is a person editing the accepted stub.
4. Should the `unrouted` leak fix ship on its own, ahead of the rest? It's small and affects 0.11 to 0.15 today.

## Revisit if

- Captures with bodies of other types (XML, protobuf) matter.
- Teams want stubs per condition from traffic beyond status (latency spikes, timeouts).
- A capture source can attest what it saw (a signed export), which might justify keeping more.
