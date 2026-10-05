# 0005. The simulation is sealed: reaching the real network is a violation

- **Status:** Proposed
- **Date:** 2026-10-05
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Depends on:** [0002. Constraints hold on every run](0002-constraints-hold-on-every-run.md)

## Context

The app contract says the app talks to the outside world only through `ctx.effects`, so the runner can stub every call and record every side effect. Nothing enforced that. An app, a dependency, or a line an agent added could call `fetch`, open a socket or use an SDK directly. In a run, that call would really go out, or fail and get swallowed. Either way, the outcome diff would describe a world that isn't the one the app lives in, and the egress would be invisible.

That gap matters more with agents. "Send telemetry", "call this API" and "add an SDK" are ordinary agent edits. A side channel that skips `ctx.effects` also skips every constraint written over `effects`.

## Decision

1. **While Oodle runs an app, the network is sealed.** TCP and TLS socket connects (which every HTTP client, database driver and SDK ends up on) and `fetch` are refused with an error that says how to fix it. Nothing leaves the machine. The seal is in place from loading the app until the run ends.
2. **An attempt is a violation of the built-in constraint `oodle.sealed`**, recorded on the run where it happened (outcome, behavior or unknown-route probe). Like any constraint violation it blocks (0002), even if the app caught the error and carried on.
3. **An attempt while the app module loads is an error** (`sealed`, exit 2): the app can't be run in simulation as written.
4. **Opting out is a visible config change.** `sealed: false` in `oodlc/config.yaml` opens the network, and `sealed: { allow: [host, host:port] }` lets named hosts through, such as a local database. The Oodle Claude Code hook asks a person before an agent changes `sealed`.
5. **Not sealed:** Unix domain sockets (local IPC) and child processes. A child process runs outside the seal, and the docs say so.

## Options considered

### A. Leave it to the contract and code review

- Good: no magic in the runner.
- Bad: the failure is silent, and the reviewer of an agent's PR is exactly who misses it.

### B. Report escapes as behavior, without blocking

- Good: no risk of blocking on a harmless call.
- Bad: an escape means the diff can't be trusted, which is a problem with the evidence itself, not drift. Report-only escapes would sit in a PR comment while real traffic goes out on every CI run.

### C. Seal, and treat an escape as a built-in constraint violation (chosen)

- Good: it fits 0002's rule: an invariant everyone declares by adopting the app contract holds on every run, and a breach blocks.
- Good: refusing the connection means nothing real happens during a run, which is the point of a simulation.
- Bad: apps that use a local database through TCP must list it in `sealed.allow`.

### D. Run apps in an OS sandbox (network namespace, seccomp)

- Good: catches child processes and native addons too.
- Bad: platform-specific, slow to start, and hard to attribute to one run. Worth revisiting for CI.

## Consequences

- The outcome diff is evidence about the world Oodle simulated, not the real one.
- Every external dependency an app has is visible in the catalog as an effect kind and a stub.
- Code that reaches the network as a side effect of `import` must move behind `ctx.effects` or be allowed by name.

## Revisit if

- Apps commonly need child processes that talk to the network. Then sandbox at the OS level, in CI at least.
- `sealed.allow` lists grow long. That would suggest a first-class "local service" concept in the config.
