# CLI reference

`oodle <command> [options]`. Every command takes `--json` (answers for agents) and `--root <dir>` (default: the nearest folder with an `oodle/` folder).

## Exit codes

| Code | Means |
| --- | --- |
| 0 | Done: checks passed, builds agree, nothing left to do. |
| 1 | Failed: a check failed, open gaps remain, or something went wrong. The message says what. |
| 2 | Wrong usage. |
| 3 | Needs a person. The message says what, and where to answer (the inbox, when there is one). Agents stop and wait here. |

A command counts as run by a person when stdin and stdout are terminals and `OODLE_AGENT` isn't set. Anything else counts as an agent.

## Writing the spec

### `oodle init [--example]`

Starts `oodle/spec.yaml`: empty, or the dog-walking example from VISION.md. Adds `.oodle/` to `.gitignore`.

### `oodle interview`

A conversation, at a terminal, that writes the declared tier into `oodle/spec.yaml`:

1. the intent in one sentence;
2. the personas and what each can do;
3. the things the app holds (a model suggests them; you decide), with their fields, states and rules;
4. one journey per persona, with real names and values;
5. what must never happen, and the stack.

The spec is checked after every answer. The interview never writes decisions. Without a terminal it exits 3.

### `oodle compile [--check]`

Compiles what the simulation runs into `oodle/compiled/`:

- `actions.json`: the action and screen vocabulary;
- `journeys/<id>.json`: each journey as a scenario;
- `explore.json`: the exploration plan;
- `checks/<id>.json`: each constraint checked on every build, and each pinned decision, as a check.

Only what changed is compiled again. Constraints without a `check` are classified first, and the classification is written back to the spec.

`--check` changes nothing. It shows each journey line next to the steps it compiled to, and each constraint and decision next to its check, and exits 1 if anything is stale.

## Building and checking

### `oodle build [--seed n] [--from <buildId>] [--force]`

Generates the app with Claude Code in `.oodle/builds/<specHash[:8]>-<seed>/app/`, then:

1. checks the spec copy is untouched, there is no `blocked.yaml`, and the code is deterministic;
2. verifies it;
3. if it passes, adds the decisions it made to `oodle/decisions.yaml`.

A proposed decision that contradicts a pinned one becomes a `decision_moved` gap and fails the build. A passing build of the same spec and seed is reused unless `--force`. `--from` starts from a previous build, for an incremental change; the gaps check never uses it.

The manifest (`manifest.json`) records the agent's turns, tokens, cost and time.

### `oodle verify [build] [--no-explore] [--no-typecheck]`

Checks a build (an id, or an app folder; default the latest) against the spec. What blocks:

- **static:** the determinism check, the driver implementing the vocabulary, the typecheck, and what merged intents rule out;
- **journeys;**
- **constraints** checked on every build;
- **the sealed simulation:** nothing reached the network;
- **pinned decisions.**

An `unchecked` constraint or decision is a warning. The report goes to `.oodle/builds/<id>/verify.json`.

### `oodle export <buildId> <dir>`

Copies a build's app out of `.oodle/builds/`.

## Gaps and answers

### `oodle gaps [--journeys-only] [--scope intent:<id>] [--a <dir> --b <dir>]`

Builds twice (seeds 1 and 2; both must pass verify), runs both through the journeys and the exploration plan, and writes one question per user-visible difference to `oodle/gaps/`. It exits 0 and says "builds agree" when no gap is open. `--a`/`--b` diff two app folders instead of building.

### `oodle answer <gapId> --option <id> | --text "<rule>" [--target decision|domain_rule|constraint] | --dont-care | --dismiss [--reason "<why>"]`

Answers a gap and applies it to the spec in a commit, `oodle: apply g_… (<who>)`:

- **At a terminal**, you answer as `person:<git user.email>`, for any route.
- **Without one**, it counts as an agent: only gaps routed to agents, and with `--reason`.

Anything that writes the declared tier (a constraint, a domain rule, a persona's cannot) needs a person.

### `oodle answer --auto`

The local agent answers every open gap routed to agents, choosing the option most consistent with the intent and the decisions already made, and says why. It exits 3 if gaps routed to people remain.

### `oodle status`

Open gaps by route and tier, unchecked constraints and decisions, the latest build, and whether the builds agree on the current spec.

## Intents

### `oodle intent new <name> [--title "<title>"]`

Starts `oodle/intents/<yyyy-mm>-<name>.yaml`.

### `oodle intent list`

Intents, their status, who approved them, and whether the approval is stale.

### `oodle intent review <id> [--a <dir> --b <dir>]`

Applies the intent's changes to a scratch copy of the spec, builds it twice, and raises the gaps in the scenarios the change reaches, marked with the intent. Status becomes `in_review`.

### `oodle intent approve <id> [--reject] [--note "<note>"]`

People only, at a terminal (or in the inbox). Refused while the intent has open gaps. The approval is for the intent's content as it is now.

### `oodle intent merge <id>`

Writes an approved intent's changes into the spec, marks it merged, and commits. Refused if the approval is stale.

Builds read merged intents from the base ref (`intents.base`, default `main`). Until a build passes after the merge, they also check the intent's `done_when` and `keeps` journeys and what it rules out.

## The inbox

### `oodle login <url> [--project <id>] [--token <token>]`

Stores a project token for the inbox in the OS keychain. With `--project`, also writes `remote` to `oodle/oodle.config.yaml`.

### `oodle sync [--watch [seconds]]`

Pushes gaps, intents, applied answers and superseded gaps. Pulls answers and intent reviews. Applies each answer in order, with a commit. It refuses to apply over uncommitted edits to the spec. Without a remote it does nothing and says so. `--watch` keeps syncing.

## For agents

### `oodle mcp`

Oodle as an MCP server over stdio. Tools:

- `read_spec`, `read_compiled`
- `list_gaps`, `get_gap`, `answer_gap`
- `list_intents`
- `verify`

`answer_gap` takes only gaps routed to agents, with a reason. Nothing answers for people, writes the declared tier, or approves an intent.

## Environment

| Variable | Means |
| --- | --- |
| `OODLE_TOKEN` | The inbox token, instead of the keychain. |
| `OODLE_MODEL` | The model for compiling, wording and answering (default `claude-sonnet-5-5`; `model` in `oodle.config.yaml` too). |
| `OODLE_AGENT` | Set: treat the caller as an agent even at a terminal. |
| `OODLE_SCRIPTED_MODEL` | A JSON file of recorded model answers, for tests and demos. |
| `OODLE_DEBUG` | Print stack traces. |
