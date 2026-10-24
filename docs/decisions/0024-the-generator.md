# 0024. The generator: one agent per build, fenced in, checked after

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** Jean-Philippe LeBlanc (maintainer)

## Context

`oodle build` drives Claude Code, headless, to write an app from the spec. The rules say only people change the declared tier and the generator never changes a decision silently. The guide sketches the workspace, the prompt, the post-run guards and decision capture. Building it raised four questions: how the agent is kept in its lane, whether it may check its own work, how dependencies get installed, and how close two decisions have to be to count as one.

## Decision

1. **Layout.** A build lives in `.oodle/builds/<specHash[:8]>-<seed>/`. The agent works in `app/`. The manifest, transcript and verify report sit next to it. `latest` names the last build. A passing build with the same id is reused.
2. **The agent is fenced by a permission callback**, not by its prompt:
   - It may read and write only inside `app/`.
   - Under `app/oodle/` it may write only `decisions.proposed.yaml` and `blocked.yaml`; `AGENTS.md` is read-only too.
   - Bash is limited to `pnpm install`, `pnpm typecheck`, `pnpm check`, `tsc`, `wrangler d1 migrations apply <db> --local`, `ls` and `pwd`.
   - Everything else is refused, web tools included.
   - Builds never see each other.
3. **The agent may run the checks.** `pnpm check` runs `oodle verify` on the app it is writing, against the compiled journeys it can already read. This is not a way around review. The checks are the review, and running them earlier only makes a build more likely to pass.
4. **After the run, mechanically**, in this order:
   - the declared tier of the spec copy is unchanged (the tier guard), and so is every other file under `oodle/`;
   - there is no `blocked.yaml`;
   - the determinism check passes;
   - proposed decisions are read and sorted.

   A violation fails the build, whatever the agent says.
5. **Dependencies are installed by Oodle, not the agent,** before the run. `@oodle/runtime` is linked from this Oodle; `hono` is the template's pinned version.
6. **Proposed decisions are sorted cheaply first.** The same id or text, or ≥ 0.85 word overlap about the same things, is a duplicate. Below 0.3 overlap, the proposal is new. Between those, a model judges same, contradicts or different. A proposal that contradicts a pinned decision becomes a `decision_moved` gap for a person and fails the build. New decisions join `decisions.yaml` only after the build passes verify, with `created_by_build`.
7. **The gaps check needs two builds that pass verify.** A build that breaks the spec would show up as differences that aren't gaps.

## Consequences

- A real `oodle build` needs Claude Code's credentials (an API key or a login), and costs a few dollars and minutes per build. Tokens and time are in the manifest. The repository's tests use a fake agent that writes the hand-written fixture.
- Because the agent can run `pnpm check`, compiled journeys and checks must be current before a build. `oodle build` compiles first.

## Revisit if

- Agents find a way to change behavior the checks don't see. Tighten the checks, not the prompt.
- Builds pass `pnpm check` but differ wildly between seeds. The prompt may need more of the decided tier, or a stricter template.
