# 0025. Answers and the local loop: who may answer what, and how it lands in git

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

Gaps are answered locally (`oodle answer`), by a local agent (`--auto`) or in the inbox (pulled by `oodle sync`). An answer counts only once it is in the spec and committed. The guide asks for one commit per answer, with its sha recorded in the gap, a person's answer to win over an agent's, and a distinct exit code when a person is needed.

## Decision

1. **Who may answer:**
   - a gap routed to people needs `person:…`;
   - an agent may answer only gaps routed to agents, and must give a reason;
   - a person may answer anything, from a terminal;
   - writing the declared tier (a constraint, a domain rule, a persona's cannot) needs a person, whatever the route.

   This is a policy boundary in the CLI, not a security boundary. Someone at a terminal can always edit the YAML; what the rules prevent is an agent doing it as part of the loop.
2. **An agent is anyone without a terminal.** That means stdin and stdout aren't TTYs, or `OODLE_AGENT` is set. Without a terminal, anything that needs a person exits with code 3, names what needs a person, and gives the inbox URL when there is one.
3. **Two commits per apply.** Applying an answer commits `oodle: apply g_… (<who>)`. A second commit, `oodle: record where … applied`, writes that sha into `applied_in`; a commit can't contain its own sha. When a sync applies several answers, they share the second commit.
4. **Answers aren't applied over uncommitted edits to the spec.** Gap files and compiled output don't count as edits. The gaps a run raised are committed (`oodle: gaps found`) before the first answer.
5. **"Either is fine"** becomes a `dont_care` decision, and "not a real difference" goes on the ignore list. Both keep their gap from being raised again.
6. **A person's answer replaces an agent's.** The earlier answer moves to the gap's `history`, and the decision the gap wrote is replaced in place, keeping its id. An agent's answer never replaces a person's.
7. **Tokens** come from `OODLE_TOKEN` or the OS keychain (macOS `security`, Linux `secret-tool`). Without either keychain, they go in `~/.config/oodle/tokens.json`, mode 600, and `oodle login` says so.
8. **For tests and demos, `OODLE_SCRIPTED_MODEL`** names a JSON file of recorded model answers. Which model answers doesn't change the routing rules.

## Consequences

- Every answer is a commit people can read, revert or blame, with who answered in the message.
- Two commits per answer is noisier than one. Squashing them would lose `applied_in`.

## Revisit if

- The commit noise bothers people more than `applied_in` helps them. The sha can be found from the message instead.
