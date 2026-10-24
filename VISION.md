# Oodle: you manage the spec, the code is generated

**Status:** draft for discussion. Nothing here is built yet. Oodle v0 is kept at tag `v0.19.0` (and `v0-archive`); [0019](docs/decisions/0019-reset-the-spec-is-the-product.md) records why it was reset.

## The idea

People stop managing code. They manage what the app is for, who uses it, what it holds, what they go through and what must never happen. An agent generates the code from that. Oodle checks the running app against it, and tells people where what they wrote still leaves the app undecided.

Code still exists, in the repository, and anyone can read it. Nobody has to.

**Merge the intent, not the code.** The pull request made sense when code was expensive: someone spent two days on a change, and a reviewer spent twenty minutes reading it. Now an agent writes the change in four minutes, and the reviewer spends forty reading code that looks fine, while what they care about (does it do what we meant, and what else does it touch) isn't in the diff at all. Oodle moves that attention up front, to the point where changing your mind is free: people agree on what should change before anything writes a line of code, and the code ships when the checks that come from that agreement pass.

## The problem to solve: a spec says less than code does

Code is full of small decisions nobody wrote down: what an id looks like, how a list is sorted, how many items a page shows, what an error says, what an empty screen shows, who may delete what. In a codebase, those decisions live in the code, and they stay put because nobody rewrites the code from scratch.

When code is generated, they have nowhere to live. Generate the app twice from the same spec and you get two apps. Both pass every check the spec makes, and they still differ in a hundred ways a user would notice. Change one line of the spec and regenerate, and things you never touched move.

Nobody will write those hundred decisions down by hand. So Oodle can't ask for a complete spec. What it can do:

1. **Find the gaps by measuring them.** Build the app twice, independently, from the same spec. Run both in the same simulation, with the same requests, and diff what they do. Every difference is something the spec left open. A spec is complete enough when two builds agree on everything a user can see.
2. **Turn each gap into a question.** "Two builds disagreed: one lists walks newest first, the other by start time. Which one?" The interview asks about gaps that really showed up, not from a checklist.
3. **Keep what the generator decided, in the spec.** Wherever the spec is silent, the generator writes down what it chose, in the spec's own words. That decision is pinned: the next build must keep it. A person can change it, make it a rule, or say they don't care.

So the spec has two tiers:

| Tier | Written by | Changed by |
| --- | --- | --- |
| **Declared**: what people said | People, through the interview or by hand | People only |
| **Decided**: what the generator chose where people said nothing | The generator, as it builds | People can override any of it. The generator adds to it, and never changes a decision silently. |

Code is generated from both. The decided tier is what the code used to remember.

## What people manage

Six kinds of entry, in one folder (`oodle/`).

| Entry | Says | Why it narrows the app |
| --- | --- | --- |
| **Intent** | Why the app exists | Breaks ties the rest leaves open |
| **Personas** | Who uses it, and what each may do | Permissions are where most guesses go wrong |
| **Domain** | The things the app holds: their fields, the states each moves through, and the rules between them | Outcome-only specs never say what the nouns are |
| **Journeys** | What each persona does, step by step, with real example values, and what they see at each step | Examples pin down far more than statements |
| **Constraints** | What must never happen, plus the stack and the requirements that aren't about features: speed, data, limits | One place for every "must" |
| **Decisions** | Everything else, mostly written by the generator | The memory code used to be |

A small example, for an app that books dog walks:

```yaml
intent: Owners can book a trusted walker in under a minute, and walkers get paid for every walk they do.

personas:
  owner:  { can: [book walks, cancel their own walks, rate a walker] }
  walker: { can: [set availability, accept or decline walks, see their earnings] }

domain:
  walk:
    fields: { owner, walker, starts_at, minutes: [30, 60], price, status }
    states: requested -> accepted -> done | declined | cancelled
    rules:
      - A walker has at most one walk at any moment
      - An owner can cancel for free until 2 hours before starts_at

journeys:
  - id: first-booking
    persona: owner
    steps:
      - Ada opens the app, picks Sam for Tuesday 9:00, 30 minutes: she sees "Requested, $20"
      - Sam accepts: Ada sees "Accepted" and gets an email
      - Ada cancels on Monday at 18:00: she sees "Cancelled, no charge"

constraints:
  - An owner is never charged for a walk that didn't happen
  - No one sees another owner's address
  - Booking answers within 300 ms at p95 in production   # checked in production, reported only
  - Runs on Cloudflare Workers with D1                   # the stack is a constraint when you care

decisions:                                               # written by the generator, pinned
  - Walks are listed by starts_at, soonest first
  - Prices are shown in the owner's currency, two decimals
  - Declining a walk asks the walker for no reason
```

The YAML shape will change. The six kinds of entry are the part to argue with.

### Where the stack and requirements like p99 go

They are constraints, because they are things people require. Each says how it is checked:

- **Checked on every build**, in the simulation: permissions, idempotency, privacy ("an address never leaves the app except to the walker"), limits, and a simulated time budget per step.
- **Checked in production**, from real traces: p95, p99, availability, error rate. Reported, never blocking a build, since a simulation can't measure them.
- **Given to the generator**, not checked: the stack, expected data volume, retention, where data lives. If nobody says, the generator picks and writes a decision.

## The loop

```
oodle interview    # a conversation that writes intent, personas, domain, journeys and constraints
oodle build        # an agent generates the app, and writes a decision for each gap it fills
oodle verify       # runs every journey and checks every constraint and decision, in the simulation
oodle gaps         # builds twice, independently, diffs them, and turns each difference into a question
```

## Changing the app: the intent merge

Every change after the first build is an **intent**, agreed and merged before any code exists. It says, plainly enough that a teammate and an agent read it the same way:

- **what should change**: the edits to the spec (a new journey step, a changed rule, a new constraint);
- **why**: in words someone can argue with;
- **what has to stay true**: the journeys and constraints it must not move, and what it rules out (new dependencies, new outside services, new routes, anything beyond what it names);
- **how we'll know it worked**: the journeys that must pass afterwards, and for anything non-deterministic, the evals that must.

Before anyone approves it, Oodle builds the change twice and runs the gaps check on it, so the questions the change leaves open come up during review, not after. Answering them is the arguing that used to happen in pull request comments, done while nothing is built yet.

Someone approves the intent, and it merges. Then:

```
intent merged  →  oodle build  →  checks  →  ships, or goes back with what failed
```

Nobody reads the code diff. Review is the checks the intent produces:

| Check | From the intent | Where |
| --- | --- | --- |
| Journeys and constraints | Written before the build, from "what should change" and "what has to stay true" | Every build, in the simulation |
| Pinned decisions | Everything the change didn't name stays as it was | Every build, in the simulation |
| What it ruled out | New dependencies, outside services, routes | Every build |
| Evals | For steps whose answer isn't fixed (search ranking, generated text) | Every build |
| Behavior against real traffic | Recorded requests replayed against the new build, diffed against the old one | Before release |
| Canary | The production constraints (p95, error rate) on a small share of traffic, with automatic rollback | Release |

If the build does what the intent said and nothing it ruled out, it ships. If something slips through, the fix goes into the intent or the checks, not into someone reading harder.

The names that matter are on the intent and its checks: decisions people actually made, instead of an approval on 600 skimmed lines.

Checks miss some things: security holes, dependencies nobody asked for, code that works today and is hard to change later. Automated scanning on every build, and regular reviews of the whole system, catch those better than a tired person reading a diff.

## Rules

- **Only people change the declared tier.** The generator never edits intent, personas, domain, journeys or constraints. If one is wrong or impossible, it stops and says so.
- **The generator never changes a decision silently.** A build that would move one reports it as a question.
- **What blocks is what was declared or pinned.** A journey that fails, a constraint broken, or a decision moved stops the build.
- **Only merged intents count.** A change can't approve itself by adding its own intent: the build reads intents from what was already merged. (This carries over from v0's change files, decision 0012.)
- **No human reads the code to let it ship.** People approve intents. The checks approve builds.
- **The simulation is sealed and deterministic.** Two runs of the same build give the same answers, so any difference between builds is a real gap. This part carries over from v0.

## The first slice

One thin path, end to end, on one stack (Hono on Cloudflare Workers with D1, which v0 already runs in process):

1. `oodle interview` writes the spec for the dog-walking example.
2. `oodle build` drives Claude Code to generate it and write its decisions.
3. `oodle verify` runs its journeys and constraints.
4. `oodle gaps` builds it twice and asks about what differs.

Only what this slice needs is ported from `v0-archive`: probably the sealed runner, the SQLite simulation, the matchers and the differ. Everything else stays in the archive until something needs it.

## Open questions

- **The screen.** A web app's users see pages. Journeys need to check what is on screen (a browser, driven by the simulation), not only HTTP answers. This was out of reach in v0 and is central here.
- **How decisions are captured.** Does the generator write them as it goes, does Oodle infer them from what a build does, or both? Too fine-grained and they become noise. Too coarse and they don't pin anything.
- **What counts as "a user can see it".** The gaps check must ignore differences nobody would notice (internal names, log lines) and catch the ones they would.
- **Cost.** Building twice to find gaps costs two builds. Maybe only on spec changes, or only for the journeys a change reaches.
- **Where the code lives.** Generated code is committed so it can run and be audited, but no one reviews it to merge. Whether it sits on the same branch as the spec, or somewhere only the build writes, is open.
- **Replaying real traffic and canaries.** Both need a running production app. The first slice stops at the simulation. Release checks come next.

## How we'll know it works

- Two independent builds from the same spec pass the same journeys and agree on everything a user can see.
- Changing one line of the spec moves only what that line is about.
- A change goes from merged intent to shipped with no one reading its code, and when something slips through, the fix lands in the intent or a check.
- Someone new can explain the model after reading the first screen of the README.
