# Oodle for coding agents

Agents make code cheap. What they need from a project is a target that doesn't move when the code does, plus guardrails on the target itself. Oodle gives both: the catalog in `oodlc/` is the target, and only a person can change what in it blocks a merge.

| You want the agent to… | Oodle gives it |
| --- | --- |
| build against a spec, not tests it wrote itself | outcomes, run with `oodle run --only` and explained with `explain` |
| write the promise before the code | `status: proposed` outcomes that run but never block ([0006](decisions/0006-proposals-and-propose-only-agents.md)) |
| never weaken a promise to get green | propose-only writes, and a hook that asks you before an approved entry changes |
| not stop while something it broke is broken | a Stop hook running `oodle check` |
| write fewer, sharper tests | conditions with `when`, `oodle mutate`, and `oodle mutate --tests` to prune |
| ship secure code | the `security.*` conditions, constraints over `request`, and a sealed simulation ([0004](decisions/0004-conditions-carry-expectations.md), [0005](decisions/0005-sealed-simulation.md)) |

## Claude Code

Install the plugin. It bundles the hooks, the MCP server and a skill:

```
/plugin marketplace add oodlc/oodle
/plugin install oodle@oodlc
```

The project needs Oodle installed locally (`npm install -D @oodlc/oodle`), since the plugin runs `npx --no-install oodle`.

What it does:

| Piece | Effect |
| --- | --- |
| **SessionStart** hook (`oodle hook session-start`) | Tells the agent the catalog's size and the rules: build against outcomes, propose new ones, never edit approved ones, external calls only through `ctx.effects`. |
| **PreToolUse** hook (`oodle hook pre-tool-use`) | Before an `Edit`, `MultiEdit` or `Write` to a catalog file, works out what the edit does to approved entries. Changing, removing, approving (deleting `status: proposed`) or silencing (adding it) an outcome, constraint or intent **asks you first**, and so do changes to `sealed`, `probe` or `app` in `config.yaml`. Shell commands that rewrite `oodlc/*.yaml` ask too. Set `OODLE_HOOK_STRICT=1` to refuse instead of asking. |
| **Stop** hook (`oodle hook stop`) | Runs `oodle check` (or `oodle run` outside git). If an outcome the agent can fix is broken or failing, a constraint is violated, the catalog doesn't lint, or the app doesn't load, it **sends the agent back to work** with the findings and a reminder not to weaken outcomes. Things only you can approve (changed, redefined or removed outcomes, constraint changes) are shown to **you** instead. After 3 blocked attempts in a row it lets the agent stop and tells you why. |
| **MCP server** (`oodle mcp`) | Tools: `run`, `check`, `lint`, `catalog`, `explain`, `mutate`, `propose`, plus a `draft` prompt. No tool edits or removes an approved entry. |
| **Skill** (`oodle`) | How to work against a catalog: the loop, writing fewer and better tests, security, and what never to do. |

Without the plugin, wire the same pieces by hand:

```bash
claude mcp add oodle -- npx --no-install oodle mcp
```

```jsonc
// .claude/settings.json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx --no-install oodle hook session-start" }] }],
    "PreToolUse": [{ "matcher": "Edit|MultiEdit|Write|Bash", "hooks": [{ "type": "command", "command": "npx --no-install oodle hook pre-tool-use" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx --no-install oodle hook stop", "timeout": 600 }] }]
  }
}
```

Other agents can use the same commands: each hook reads an event as JSON on stdin and answers in Claude Code's hook JSON on stdout.

## The loop

1. **Read** the catalog (`catalog` tool, or `oodlc/*.yaml`).
2. **Propose** the outcomes a feature promises before building it: `oodle propose draft.yaml`, or the `propose` tool. From a brief: `oodle draft brief.md | claude -p | oodle propose -`.
3. **Iterate** with `oodle run --only "<glob>" --json` until the proposals hold. `explain <id>` shows what the app returned and emitted under each condition.
4. **Check** with `oodle check --json` and follow it. The Stop hook does this anyway.
5. **Hand over** a PR with the outcome diff. You approve the proposals by deleting their `status: proposed` lines.

## Fewer, better tests

**Outcomes over unit tests.** An outcome tests what someone outside sees, so refactors don't touch it. Variants are conditions, not copies:

```yaml
- id: checkout.payment-confirmed
  conditions: [first_purchase, payment_provider_slow, security.no-credentials, security.replayed]
  expect: { status: 200, body: { status: confirmed }, effects: [{ kind: payment.capture, count: 1 }] }
  when:
    security.no-credentials: { status: 401, body: { error: unauthorized }, effects: [{ kind: payment.capture, count: 0 }] }
```

**Measure the catalog with `oodle mutate`.** Oodle plants small bugs (a flipped comparison, a dropped effect, a changed literal) in the files the app imports, and runs the outcomes against each one in its own mirror of the repository:

```
Survived  no outcome or constraint noticed these bugs
  ✘ src/checkout.ts:9   literal   404 → 405
  ✘ src/checkout.ts:29  remove-statement  removed customer.orders = (customer.orders ?? 0) + 1;

What caught them  unique = bugs nothing else catches
  checkout.payment-confirmed   26 bugs · 8 unique
  ...
▲ 65% of planted bugs caught  37 caught · 6 only noticed · 2 internal only · 14 survived
```

- **Survived**: nothing checks this. Here, no outcome covers an unknown customer, and nothing checks the order count in state. Each survivor is an outcome or condition worth proposing.
- **Only noticed**: the output changed but no expectation failed, so only a reviewer reading the `oodle check` diff would catch it. Tighten the expectation.
- **Internal only**: only `internal.*` effects changed. Outcomes allow that on purpose, so these don't count against the score.
- **Redundant outcomes**: every bug they catch, a smaller set of outcomes also catches.

`--min-score 80` turns the score into a CI gate.

**Prune unit tests with `oodle mutate --tests "npm test"`.** Each mutant also runs through your suite (TAP or `node --test` output). Tests whose every caught bug an outcome caught too are listed as **covered by the catalog**: candidates to delete, after a read, since a test can still guard inputs no outcome sends. Tests that caught no planted bug are listed apart, because that is no evidence either way. Tests that catch bugs the catalog misses are worth keeping, or turning into an outcome.

## Security

- **Sealed simulation.** The app reaches the world only through `ctx.effects`. A direct `fetch`, socket or SDK call is refused and blocks as `oodle.sealed`, so an agent can't add a side channel that skips your constraints.
- **The security pack.** `security.no-credentials`, `security.injection`, `security.oversize`, `security.extra-fields` (mass assignment and `__proto__` pollution) and `security.replayed` need no app knowledge. Put them on outcomes with `when`, and on every route nothing describes with `probe: { conditions: [...] }` in `oodlc/config.yaml`.
- **Constraints over `request`.** "A request without credentials never causes an external effect" is one line, and it holds on every run, including a route an agent added five minutes ago:

  ```yaml
  constraints:
    - id: no-side-effects-without-credentials
      statement: A request without credentials never causes an external effect
      check: "!!(request.headers && request.headers.authorization) || effects.every(e => e.boundary === 'internal')"
  ```
- **Give the security team the folder.** A `CODEOWNERS` entry for `oodlc/constraints.yaml` and `oodlc/config.yaml` means no agent and no individual can loosen an invariant or open the seal alone.
