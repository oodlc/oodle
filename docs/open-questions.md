# Open questions: what we learn

The open questions in [VISION.md](../VISION.md) are left open on purpose. This file logs what building the first slice teaches about each, as it happens. Nothing here is a decision; decisions go in `docs/decisions/`.

The numbers come from the first real runs (2026-10-24):
- **Round 1:** two independent `oodle build`s of `examples/dogwalk`, with Claude Code on Sonnet 5.5 and the README spec plus its 3 decisions, followed by `oodle gaps` and `oodle answer --auto`.
- **Round 2:** two more builds from the spec those answers produced.

## Does answering gaps make builds converge?

Not in two rounds.

| | Round 1 | Round 2 |
| --- | --- | --- |
| Pinned decisions in the spec | 3 | 22 + 4 adopted |
| Both builds pass verify | yes (5/5 checks) | yes (24/24 checks, 63 scenarios) |
| Open questions after the gaps check | 24 (2 for people) | 36 (0 for people) |
| Answered questions raised again | — | 0 |

- **Pinned decisions held.** Every decision answered in round 1 was kept by both round-2 builds.
- **The disagreement moved instead of shrinking.** Round 2's questions are about things round 1's builds happened to agree on: the price of a 60-minute walk ($35 or $40), whether the walker gets an email when a walk is requested, what refusing an action says. These are real gaps in the spec; the README's example never says what an hour costs.
- **Revisit after three more rounds.** If the count doesn't fall, the gaps check may need to ask about whole areas ("how are refusals worded?") rather than each instance, or the spec needs a place for house style.

## Decision granularity

- A build proposes 24–34 decisions.
- Both builds of a round proposed the same 9 (round 1) and 4 (round 2), judged as the same by meaning, not wording. Those are adopted.
- Before the fix in 0024 (point 8), adopting build A's decisions before build B ran made B flag 2 of A's 27 as moved.
- Proposals are mostly one behavior each, phrased as the guide asks ("A walker who isn't signed in is sent to the home screen"). Some are too fine, like individual error messages; those are what the gaps check then raises.

## What counts as user-visible

- **Clustering is the lever.** Signing wording gaps by place and sample gave 85 questions for one pair of builds. Signing them by the words only one side shows gave 24 (0023).
- **Date formats** ("Wed 4 Nov 2026, 09:00 UTC" against "2026-11-04 09:00 UTC") and **"Signed in as …" headers** were the biggest sources of noise before that.
- **Error-message wording** is now the largest group, and it's arguably one house-style decision rather than many.
- No dismissals yet (no person has answered).

## Cost of building twice

| Build | Agent turns | Wall time | Cost (Sonnet 5.5) |
| --- | --- | --- | --- |
| Round 1, seed 1 | 53 | 6m 39s | $10.35 |
| Round 1, seed 2 | 75 | 14m 49s | $21.62 |
| Round 2, seed 1 | 88 | — (resumed) | $14.07 |
| Round 2, seed 2 | 27 | 4m 44s | $9.25 |

- About $14 a build, so about $28 a gaps round. The very first build ran on Opus 5.5: 35 turns, 5 minutes, $19.62.
- Model calls for compiling checks and wording questions cost cents.
- Verify itself is about one second for 60 scenarios, so the simulation isn't where the cost is.
- An intent review builds twice too; scoping it to the scenarios a change reaches doesn't make the builds cheaper. Reusing a passing build for the unchanged side, or `--from` for small changes, are the obvious next levers.

## Where generated code lives

- For now, `.oodle/builds/<id>/`, with `oodle export` to copy one out.
- Nothing yet argues for committing it. Builds are reproducible from the spec only in what the checks pin. The four apps are about the same size (630 to 750 lines in 2 to 4 source files), but split code and tables differently: one keeps ratings and availability in their own tables, another in the walks table.
