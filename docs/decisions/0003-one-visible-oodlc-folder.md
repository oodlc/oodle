# 0003. Everything lives in one visible oodlc/ folder

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

In v0 a project put three things at its root: an `oodle.yaml` config, a catalog directory (named by the config, conventionally `catalog/`), and `.oodle-tmp/` for the git worktrees `oodle check` creates.

That caused three problems:

1. **Scattered.** Oodle claimed three root entries in someone else's repository, and the one that matters most, the catalog, had the most generic name.
2. **Name collisions.** `catalog/` is a common name for real code. The checkout example has a product catalog.
3. **Hard to own.** "Who approves outcome changes" is the core question of OODLC, and there was no single path to give a `CODEOWNERS` entry.

The catalog is effectively the product spec: what customers must experience, approved by humans. Whatever we choose has to keep it easy to find and read.

## Decision

**A project keeps all of its Oodle files in one visible folder, `oodlc/`, at the project root.**

- `oodlc/config.yaml` is the config (`app`, `defaults`). Every other `.yaml` file in `oodlc/` is catalog. The `catalog` key is no longer needed.
- `app` stays relative to the project root, the directory that holds `oodlc/`. The app itself lives wherever it already does.
- Oodle finds a project by walking up to the nearest `oodlc/`, the way git finds `.git/`. The project argument can name the project, its `oodlc/` folder, or the config file.
- `oodle check` keeps its temporary worktrees in `.git/oodle/worktrees/`, so nothing appears in the repository and nothing needs ignoring.
- **Compatibility:** during v0, a root `oodle.yaml` with a `catalog` key still works. Text output and `oodle doctor` nudge users to run `oodle init --migrate`, which moves the files with `git mv` so history follows them.

## Options considered

### A. Keep `oodle.yaml` and a catalog directory

- Good: no change for anyone.
- Bad: keeps all three problems above.

### B. One hidden folder, `.oodlc/`

- Good: matches `.github/`, `.changeset/` and agent folders like `.claude/`. Out of the way.
- Bad: hides the most important human-reviewed artifact from `ls` and file trees. That works against the idea that outcomes are declared and reviewed in plain sight.

### C. One visible folder, `oodlc/` (chosen)

- Good: one path to find, review and give a `CODEOWNERS` entry. Named after the framework, so it doesn't collide with application code. Visible wherever code is read.
- Bad: one more visible root entry, and a breaking layout change, softened by legacy support and `--migrate`.

### D. Allow inline definitions in a single `oodle.yaml`

- Good: one file for tiny projects.
- Bad: a second way to lay out a project, and it doesn't scale past a few outcomes. It can be added later inside `oodlc/` if needed.

## Consequences

- `oodle init` scaffolds `oodlc/`, and `oodle init --migrate` moves a v0 project.
- This repository and `examples/checkout` use the new layout. This repository's dogfood adapter is `test/dogfood.ts`: it is test harness, so it stays out of `oodlc/`.
- `spec/config.schema.json` no longer requires `catalog`.
- `oodle check` can compare a base on the old layout with a head on the new one, so the migration commit itself diffs cleanly.
- `oodlc/` holds declarations only: config and catalog YAML. Apps and test harnesses live with the code, and `config.yaml` points at them.

## Revisit if

- Teams regularly need several catalogs per repository that don't map to one project each.
- Tooling or editors handle a hidden folder better than a visible one, enough to outweigh visibility.
- The legacy layout is still in use when v1 is planned. Drop it at v1.
