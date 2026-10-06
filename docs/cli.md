# The Oodle CLI

`oodle help` shows the same information in the terminal, and `oodle help --json` gives it as JSON for scripts and agents. This page explains the conventions behind it.

```
oodle <command> [project] [flags]
```

| Command | What it does |
| --- | --- |
| `oodle run [project]` | Run every outcome and behavior under every condition |
| `oodle check [project]` | Outcome diff of the working tree against a git ref. `--approve id@fingerprint` approves an intended change to a promise |
| `oodle diff <base> <head>` | Outcome diff between two project checkouts |
| `oodle lint [project]` | Validate the catalog and its traceability |
| `oodle init [dir]` | Start a project: an `oodlc/` folder and a starter catalog, plus `oodle.app.ts` around the service already there (or a starter app). For a service, it names the outbound calls it finds under `effects`, stubs each with a placeholder, and proposes an outcome for each route in `oodlc/proposed.yaml`. `--ci` adds the GitHub workflow, `--migrate` moves a v0 project in |
| `oodle doctor [project]` | Check your environment and project setup: the app is yours, every effect it names has a stub, nothing escapes the simulation, two runs agree |
| `oodle mutate [project]` | Plant small bugs in the app and see which ones the catalog catches. `--tests <cmd>` finds unit tests the catalog covers |
| `oodle propose <file> [project]` | Add drafted entries as proposals in `oodlc/proposed.yaml`, never changing an existing one. `--routes` proposes an outcome for each route nothing describes, from probing it |
| `oodle draft <brief> [project]` | Print the prompt that drafts catalog entries from a brief, for any agent |
| `oodle mcp [project]` | Serve Oodle to coding agents over MCP (stdio) |
| `oodle hook <event>` | Answer a coding agent's hook: `session-start`, `pre-tool-use`, `stop`. See [agents.md](agents.md) |
| `oodle completion <shell>` | Print a bash, zsh or fish completion script |
| `oodle hello` | Meet Oodle |
| `oodle help [command]` | Help for oodle or one command |

Every command takes `-h`/`--help`. `oodle help run`, `oodle run --help` and `oodle run -h` all show the same page.

## Finding the project

A project is the directory that holds an `oodlc/` folder. With no `project` argument, Oodle walks up from the current directory to the nearest one, the way git finds `.git`, so `oodle run` works from anywhere inside a project, including from inside `oodlc/`. You can also pass the `oodlc/` folder or its `config.yaml`. If you pass a path with no project, Oodle suggests the nearest directories that have one.

A v0 project (`oodle.yaml` plus a catalog directory) still runs, and Oodle suggests `oodle init --migrate`. That moves the files into `oodlc/` with `git mv`, so history follows them.

## Output

Results go to **stdout**. Oodle's reactions, progress, hints and errors go to **stderr**. When you pipe or redirect output, you get only the results.

| Format | Flag | Commands | Notes |
| --- | --- | --- | --- |
| text | default | all | Designed for people; may change between versions |
| json | `--json` or `--format json` | run, check, diff, lint, init, doctor, mutate, propose, help | Stable; for scripts and agents |
| md | `--format md` | check, diff | The PR comment. Default for `check` and `diff` when stdout is piped |

Rules for `--json`:

- stdout gets exactly one JSON document, even when the command fails.
- Every document has an `ok` boolean.
- A failure looks like `{ "ok": false, "error": { "code", "message", "hint", "problems" } }`. Scripts can match on `error.code`, which is stable: `usage`, `no-project`, `no-match`, `catalog`, `app-load`, `app-contract`, `app-crash`, `sealed`, `exists`, `no-files`, `baseline`, `not-holding`, `proposal`, `proposal-exists`, `internal`.
- stderr stays silent.

`check --md diff.md` and `diff --md diff.md` also write the markdown to a file, whatever the output format.

### Colour, symbols and motion

Settings are applied in this order, first match wins:

1. `--color always|never|auto` and `--no-color`
2. [`NO_COLOR`](https://no-color.org) (any non-empty value)
3. `FORCE_COLOR`
4. `TERM=dumb`
5. Whether the stream is a terminal

stdout and stderr are decided separately, so `oodle run | less` keeps colour in Oodle's messages while the results stay plain.

Unicode symbols fall back to ASCII on the Linux console and legacy Windows terminals, or when `OODLE_ASCII=1` is set. The spinner appears only on an interactive stderr, and only after 200ms, so fast commands never flicker. Animation stops in CI, under `OODLE_STILL=1`, or with colour off.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Nothing a human declared is broken |
| 1 | Blocking: an outcome or constraint is not holding, or the catalog has lint errors |
| 2 | Could not run: bad usage, no project, invalid config, or the app failed to load |
| 130 | Interrupted with Ctrl-C |

Behavior drift, unknown routes and proposals never change the exit code. `oodle mutate` exits 1 only below `--min-score`, or when the catalog doesn't hold before mutating (`not-holding`).

## Errors

Every error says what went wrong and what to do next. Typos in commands, flags, shells and project paths get a "did you mean". `--debug` (or `OODLE_DEBUG=1`) adds stack traces.

An error that is not Oodle's to explain is a bug. Oodle says so and links a prefilled GitHub issue with the command, the stack, and the Oodle, Node and platform versions.

## Ctrl-C

`oodle check` checks out the base ref in a temporary git worktree under `.git/oodle/worktrees/`, so nothing appears in your repository. On Ctrl-C, Oodle removes the worktree and exits with 130. A second Ctrl-C exits at once; `git worktree prune` tidies anything left behind. If a worktree for the same commit is left over from an earlier crash, the next run replaces it.

## Watch mode

`oodle run --watch` and `oodle lint --watch` re-run whenever a file in the project changes, ignoring `node_modules`, `.git` and editor temp files. Each run is a fresh process, so the app is always re-imported.

Every run starts with a `WATCH` or `RERUN` line naming the files that changed. It ends with a status block:

```
────────────────────────────────────────────────────────────
 FAIL  1 of 4 outcomes not holding  → now failing, was passing
run #3 · 11:55:57 · 34ms   history ✔ ✔ ✘
watching examples/checkout for changes · r re-run · q quit
```

- The badge says `PASS` or `FAIL`, with the same verdict as a normal run.
- The transition reads "now failing", "fixed", "still passing" or "still failing". When some outcomes are already failing, it names the ones that are newly failing and the ones that were fixed.
- The history shows the last twelve runs. The terminal bell rings when the status flips.
- Press `r` (or Enter) to re-run and `q` to quit.

`--watch` combines with `--only`:

```bash
oodle run --watch --only "checkout.*"
```

## CI

### The GitHub Action

`oodle init --ci` writes this workflow for you:

```yaml
name: Oodle
on:
  pull_request:
  pull_request_review:       # a review can approve a change, so it re-runs the check
    types: [submitted]
permissions:
  contents: read
  pull-requests: write       # for the outcome diff comment, and to read reviews
concurrency:
  group: oodle-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  outcomes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci          # your app's dependencies
      - uses: oodlc/oodle@v0
        with:
          project: services/checkout
```

Keep it in its own workflow. A review re-runs every job of the workflow it triggers, and a job that skips on review events would report as passed for the commit, hiding its earlier result.

The action:

- compares against the pull request's base branch, or the previous commit on a push, and fetches that commit even when the checkout is shallow;
- treats a base with no `oodlc/` yet as promising nothing, so the pull request that adds Oodle reports every outcome as `new`, and passes if they hold;
- collects approvals from the pull request's reviews and comments (below);
- runs `oodle check`;
- posts the outcome diff as one pull request comment, updated in place on every push;
- fails the job only when something blocks.

| Input | Default | |
| --- | --- | --- |
| `project` | `.` | Directory that holds `oodlc/` |
| `base-ref` | PR base, or the commit before a push | Ref to compare against |
| `comment` | `true` | Post and update the PR comment |
| `approvals` | `true` | Read `/oodle approve` lines from reviews and comments |
| `allow-self-approval` | `false` | Let the PR's author approve their own changes. For a repository with one maintainer |
| `fail-on-blocking` | `true` | Fail the job on blocking findings. If Oodle cannot run, the job always fails |
| `node-version` | `22` | Node.js for Oodle |

Outputs: `blocking` (count), `approved` (count), `exit-code`, `markdown-file`. On pull requests from forks the token is read-only, so the action skips the comment with a warning. The diff is still in the job summary.

### Approving a change to a promise

A change to a promise (an outcome that `changed`, was `redefined` or `removed`; a constraint `redefined` or `removed`) blocks until a human approves it. Each one carries a fingerprint, and the outcome diff comment ends with the line to approve them all:

```
/oodle approve checkout.payment-confirmed@1a2b3c4d
```

A maintainer submits a pull request review (approve or comment) containing that line. The review re-runs the check, and the change shows as approved, with who approved it. The rules (see [0007](decisions/0007-approvals-in-ci.md)):

- Only reviews and comments by people with write access count (`OWNER`, `MEMBER`, `COLLABORATOR`), never bots, and never the pull request's author unless `allow-self-approval` is on.
- An approval is bound to the change as it is now: the definitions before and after, and what was observed before and after. If a later push changes it, the approval is reported stale and the change blocks again.
- A `broken` outcome or a constraint violation is never approvable. Fix the code, or redefine the outcome in the catalog and approve the redefinition.

Locally, or in another CI, pass the same tokens: `oodle check --approve checkout.payment-confirmed@1a2b3c4d`, or `--approvals approvals.json` with `[{ "id", "fingerprint", "by" }]`.

### Without the action

With `GITHUB_ACTIONS=true` (set automatically in Actions), any `oodle` command writes:

- an error annotation for every broken outcome and constraint violation,
- an annotation on the catalog file for every lint finding,
- the outcome diff, appended to the job summary (`$GITHUB_STEP_SUMMARY`) by `check` and `diff`.

```yaml
- run: npx oodle check --base-ref origin/${{ github.base_ref }} --md diff.md
```

## Shell completion

Completion scripts are generated from the command registry, so they always match the real flags. `--base-ref` completes git refs.

```bash
oodle completion zsh > "${fpath[1]}/_oodle"
oodle completion bash >> ~/.bashrc
oodle completion fish > ~/.config/fish/completions/oodle.fish
```

## Environment

| Variable | Effect |
| --- | --- |
| `NO_COLOR` | Disable colour |
| `FORCE_COLOR` | Force colour on, even when piped (`0` forces it off) |
| `OODLE_FORMAT` | Default output format, e.g. `json` for agents and scripts |
| `OODLE_QUIET` | Same as `--quiet` |
| `OODLE_STILL` | Draw Oodle without animation |
| `OODLE_ASCII` | ASCII symbols instead of unicode |
| `OODLE_DEBUG` | Same as `--debug` |
| `GITHUB_ACTIONS` | Annotations and job summary |
| `OODLE_HOOK_STRICT` | `oodle hook pre-tool-use` refuses catalog edits instead of asking |

## Mutation testing

`oodle mutate` plants small bugs (flipped comparisons and logic, arithmetic, negation, changed literals and strings, removed effects and assignments) in every file the app imports, and for a Next.js app every route file and the middleware (or `--files`). It skips `@oodlc/oodle/adapter` and `/next` modules, which only wire the app in, and entry-point boilerplate no simulated run reaches: `listen(...)`, `process.argv`, `import.meta.main`, `require.main`, `process.env.PORT` and `console.*` lines. It runs `oodle run --json` against each in a mirror of the repository under `.git/oodle/mutants/`, removed afterwards, with a timeout of five times the baseline run. Each mutant is:

| Status | Meaning |
| --- | --- |
| killed | An outcome failed or a constraint was violated |
| noticed | Customer-visible output changed but every expectation passed: only `oodle check`'s `changed` would catch it |
| internal | Only `internal.*` effects changed, which outcomes allow. Not counted |
| survived | Nothing that is checked changed |
| timeout | The mutant hung. Counted as caught |
| invalid | The mutant did not load. Not counted |

The score is caught ÷ (all − invalid − internal). `--max` samples evenly (default 200), `--jobs` sets parallelism, and `--only` limits the outcomes run. With `--tests "<cmd>"`, the command runs in each mirror too, and failing tests are read from TAP (`not ok N - name`) or spec (`✖ name (1ms)`) output. A test whose every caught bug an outcome caught too is **covered by the catalog**: a candidate to delete after a read, since a test can still guard inputs no outcome sends. A test that caught no planted bug is listed apart (`no_kills` in JSON): that's no evidence either way.

## For agents

See [agents.md](agents.md) for the Claude Code plugin, the MCP server and the hooks.

- `oodle help --json` describes every command, flag, format, exit code and environment variable.
- Set `OODLE_FORMAT=json`, or pass `--json`, and parse stdout. Branch on `ok` and the exit code, not on text.
- `oodle run --only <glob> --json` keeps the output small while you iterate on one outcome.
- `oodle doctor --json` tells you, before anything else, whether the project is wired up correctly.
