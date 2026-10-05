# The Oodle CLI

`oodle help` shows the same information in the terminal, and `oodle help --json` gives it as JSON for scripts and agents. This page explains the conventions behind it.

```
oodle <command> [project] [flags]
```

| Command | What it does |
| --- | --- |
| `oodle run [project]` | Run every outcome and behavior under every condition |
| `oodle check [project]` | Outcome diff of the working tree against a git ref |
| `oodle diff <base> <head>` | Outcome diff between two project checkouts |
| `oodle lint [project]` | Validate the catalog and its traceability |
| `oodle init [dir]` | Start a project: `oodle.yaml`, a starter catalog and app |
| `oodle doctor [project]` | Check your environment and project setup |
| `oodle completion <shell>` | Print a bash, zsh or fish completion script |
| `oodle hello` | Meet Oodle |
| `oodle help [command]` | Help for oodle or one command |

Every command takes `-h`/`--help`. `oodle help run`, `oodle run --help` and `oodle run -h` all show the same page.

## Finding the project

With no `project` argument, Oodle walks up from the current directory to the nearest `oodle.yaml`, the way git finds `.git`, so `oodle run` works from anywhere inside a project. If you pass a path with no `oodle.yaml`, Oodle suggests the nearest directories that have one.

## Output

Results go to **stdout**. Oodle's reactions, progress, hints and errors go to **stderr**. When you pipe or redirect output, you get only the results.

| Format | Flag | Commands | Notes |
| --- | --- | --- | --- |
| text | default | all | Designed for people; may change between versions |
| json | `--json` or `--format json` | run, check, diff, lint, init, doctor, help | Stable; for scripts and agents |
| md | `--format md` | check, diff | The PR comment. Default for `check` and `diff` when stdout is piped |

Rules for `--json`:

- stdout gets exactly one JSON document, even when the command fails.
- Every document has an `ok` boolean.
- A failure looks like `{ "ok": false, "error": { "code", "message", "hint", "problems" } }`. Scripts can match on `error.code`, which is stable: `usage`, `no-project`, `no-match`, `catalog`, `app-load`, `app-contract`, `app-crash`, `exists`, `no-base-project`, `internal`.
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

Behavior drift and unknown routes never change the exit code.

## Errors

Every error says what went wrong and what to do next. Typos in commands, flags, shells and project paths get a "did you mean". `--debug` (or `OODLE_DEBUG=1`) adds stack traces.

An error that is not Oodle's to explain is a bug. Oodle says so and links a prefilled GitHub issue with the command, the stack, and the Oodle, Node and platform versions.

## Ctrl-C

`oodle check` checks out the base ref in a temporary git worktree under `.oodle-tmp/`. On Ctrl-C, Oodle removes the worktree and exits with 130. A second Ctrl-C exits at once; `git worktree prune` tidies anything left behind. If a worktree for the same commit is left over from an earlier crash, the next run replaces it.

## Watch mode

`oodle run --watch` and `oodle lint --watch` re-run whenever a file in the project changes, ignoring `node_modules`, `.git` and `.oodle-tmp`. Each run is a fresh process, so the app is always re-imported. `--watch` combines with `--only`:

```bash
oodle run --watch --only "checkout.*"
```

## CI

With `GITHUB_ACTIONS=true` (set automatically in Actions), Oodle writes:

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

## For agents

- `oodle help --json` describes every command, flag, format, exit code and environment variable.
- Set `OODLE_FORMAT=json`, or pass `--json`, and parse stdout. Branch on `ok` and the exit code, not on text.
- `oodle run --only <glob> --json` keeps the output small while you iterate on one outcome.
- `oodle doctor --json` tells you, before anything else, whether the project is wired up correctly.
