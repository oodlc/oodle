# 0018. The catalog in a browser: a local studio over the oodlc/ folder

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

The `oodlc/` folder has grown from outcomes and constraints into a description of a whole system: intents, actors, capabilities, experiences, terms, unknowns, changes, proposals and proposed stubs (0010–0015). Looking after it is now spread across many commands. `explain` draws the map, `run` says what holds, `lint` says what's wrong, `interview` asks the questions, `changes` lists the agreed changes, and the proposals are scattered across `proposed.yaml`, other catalog files and `config.yaml`.

Each command is good at its one job. What's missing is one place that answers "what does this system promise, how much of it holds, and what is waiting for me?" Today a person has to run four commands and read several YAML files to find out. A terminal is also a poor fit for a graph: an intent served by capabilities, each protected by outcomes, each run under conditions.

Two things are fixed. The files are the source of truth, reviewed in pull requests (0003, 0007). Only a person approves what blocks a merge (0006), and only a person at a terminal confirms a capability (0010).

## Decision

**`oodle ui` serves one local page over the project's `oodlc/` folder. It reads the files, runs the catalog on request, and writes back only through the code the CLI already uses.**

- **Local, not hosted.** A `node:http` server on `127.0.0.1`, started from the project. It adds no dependency and needs no account or upload, and the catalog never leaves the machine.
- **The files stay the truth.** The page holds no state of its own. It watches `oodlc/` and refreshes when a file changes, whether an editor, git or an agent changed it. A file that doesn't parse is shown with its problems, not hidden.
- **Runs happen in a child process,** `oodle run --json` and `oodle explain --json`, as the MCP server does, so the app is imported fresh. The last result is kept in memory, and the page says when the catalog has changed since.
- **What it shows:** an overview of what's waiting for a person, the system map (each intent, its capabilities with their rungs, the outcomes that protect them), every outcome, behavior and constraint under every condition, the proposals, the questions, the changes with their agent briefs, actors, experiences, terms, conditions and lint.
- **What it writes:** answers to the interview's questions, through `applyAnswers`, and approvals. An approval removes a proposal's `status: proposed` line and can sharpen its statement first. Comments and layout are kept. A write that would leave new lint errors is undone. An entry whose statement still says nothing (`saysNothing`) can't be approved.
- **Who may approve:** the server takes "a person started me" from the same signal as `oodle interview`, a terminal on stdin and stdout. Started that way, the page can approve and confirm. Started without one, for example by an agent's shell, it answers with an agent's rights: new entries arrive as proposals, and every approval or confirmation is refused with `approved`.
- **Who may connect:** each launch makes a random token, carried in the fragment of the link it prints (`#token=…`), so it never reaches a log or a referrer. The page sends it to this server only, in a header, or in the event stream's URL. Every API call needs it. A request whose `Host` isn't `127.0.0.1`/`localhost` on this port is refused, which stops DNS rebinding. So is one with a foreign `Origin`.
- **What it doesn't do:** it doesn't edit approved outcomes, constraints or intents, accept stubs, fold changes or approve a diff (`--approve`). Those stay edits a person makes in the files and a reviewer sees in a pull request.

## Options considered

### A. Keep it in the terminal

- Good: nothing new to maintain.
- Bad: the system map doesn't fit in a terminal, and the "what's waiting for me" view never exists in one place.

### B. Pages on the website (oodlc-web) that read a repository

- Good: shareable links, and nothing to start.
- Bad: the catalog would have to leave the machine or be served by a GitHub integration. It couldn't run the app, which needs the local sealed simulation. Approvals would need their own auth and audit, beside the one the pull request already gives (0007).

### C. A static page written by `explain --format html`

- Good: no server, and easy to attach to CI.
- Bad: read-only and stale the moment a file changes. Managing the catalog still happens in the terminal.

### D. A local server over the files (chosen)

- Good: always current, runs the real simulation, writes through the same audited paths as the CLI, and adds no dependency.
- Bad: one more surface that can write the catalog, so the person gate and the token have to hold. It's a process to start and stop.

## Consequences

- A team can see its system, and its backlog of human decisions, in one place, and clear the backlog without hand-editing YAML.
- Every write the page makes is an ordinary diff in `oodlc/`, so it is reviewed like any other.
- The page is one self-contained file (`src/ui.html`) with no build step. It reuses the website's colours, and status colours only ever mean a status.
- **Known limit:** the person gate is a terminal, as for `oodle interview`. An agent that can run a command under a pseudo-terminal could start `oodle ui` and approve. That is the same exposure the interview already has, and the Claude Code hook still asks before an agent's own edits approve anything. A stronger gate, such as approvals the page sends as a pull request review, can come later.
- A run takes the time two runs take (`run` and `explain`), because `run --json` doesn't list the app's routes. Adding `routes` to `run --json` would halve it.

## Revisit if

- Teams want to share the view. Then a read-only export (option C) or a CI artifact is the next step, not a hosted service.
- The pseudo-terminal gap is used in practice, or a team asks for approvals here that bind to a reviewer the way the pull request's do.
- Editing approved entries in the page is asked for often. That would need the same diff-and-approve flow as `oodle check`, not a quiet write.
