export const BOUNDARIES = ['customer', 'external', 'data', 'obligation', 'internal'] as const;
export type Boundary = (typeof BOUNDARIES)[number];

/** Drafted by an agent or the drafter and not yet approved by a human. Runs and is reported, never blocks. See docs/decisions/0006. */
export type ProposalStatus = 'proposed';

export interface Intent {
  id: string;
  statement: string;
  status?: ProposalStatus;
}

/**
 * Who uses the system: a shopper, an operator, a partner's server. Part of the
 * inventory, which explains the system and never blocks. See docs/decisions/0010.
 */
export interface Actor {
  id: string;
  statement: string;
  status?: ProposalStatus;
}

/**
 * What the system lets an actor do, and the surfaces that serve it. Discovered
 * or drafted as a proposal; a person confirms it by deleting `status: proposed`.
 * A confirmed capability can justify an outcome on its own. See docs/decisions/0010.
 */
export interface Capability {
  id: string;
  statement: string;
  actor?: string;
  intent?: string;
  /** Triggers that reach it, "METHOD /path" like an outcome's trigger. */
  surfaces?: string[];
  /** Where the claim comes from: a file, a probe, a record. Free text for now. */
  evidence?: string[];
  status?: ProposalStatus;
}

/** What an actor goes through across capabilities, and when it feels broken. See docs/decisions/0010. */
export interface Experience {
  id: string;
  statement: string;
  actor?: string;
  intent?: string;
  /** Capability ids, in the order the actor meets them. */
  steps?: string[];
  /** Failures the actor would notice. Each is a candidate condition or constraint. */
  feels_broken_when?: string[];
  /** Where the journey was seen: a capture, a trace export. Free text for now. */
  evidence?: string[];
  status?: ProposalStatus;
}

/** What a change does to one outcome or constraint, once its code lands. See docs/decisions/0012. */
export interface Amendment {
  outcome?: string;
  constraint?: string;
  statement?: string;
  /** Merged over the outcome's `expect`: body fields by key, effects by kind, the rest replaced. */
  expect?: Expect;
  when?: Record<string, Expect>;
  /** A constraint's new check. */
  check?: string;
  /** The change retires it. */
  remove?: true;
}

export const RULED_OUT = ['new effects', 'new hosts', 'new routes', 'new dependencies'] as const;
export type RuledOut = (typeof RULED_OUT)[number];

/**
 * An intent to change the system, agreed before the code exists. Once merged, it lets a code pull
 * request change exactly what it amends, inside the capabilities it reaches, and nothing it rules out.
 * See docs/decisions/0012.
 */
export interface Change {
  id: string;
  because: string;
  /** Capabilities it may touch. Without it, only the outcomes and constraints it amends. */
  reaches?: string[];
  amends?: Amendment[];
  rules_out?: RuledOut[];
}

/** A question the system can't answer about itself, and who can. See docs/decisions/0010. */
export interface Unknown {
  id: string;
  question: string;
  /** The role that can answer it: product owner, platform team. */
  ask?: string;
  /** Ids of the entries it is about. */
  about?: string[];
  /** What a person said. An answered question is no longer open; fold the answer into the catalog when you can. */
  answer?: string;
}

export interface Stub {
  result?: unknown;
  error?: string;
  latency_ms?: number;
}

/** Generic ways to make a request hostile, with no knowledge of the app. See src/security.ts. */
export const FUZZ = ['injection', 'oversize', 'extra-fields'] as const;
export type Fuzz = (typeof FUZZ)[number];

export interface Given {
  body?: unknown;
  /** Request headers. A null value drops that header; `headers: null` sends none at all. */
  headers?: Record<string, string | null> | null;
  state?: Record<string, unknown>;
  /** Rows each table of the simulated database starts with, by table name (`schema.table` outside public). Needs `database` in oodlc/config.yaml. */
  db?: Record<string, Record<string, unknown>[]>;
  stubs?: Record<string, Stub>;
  /** Send the same request this many times against the same state, e.g. 2 for a replay. Default 1. */
  repeat?: number;
  /** Rewrite the request body before sending it. */
  fuzz?: Fuzz;
}

export interface Trigger {
  /** "METHOD /path", e.g. "POST /checkout" */
  http: string;
  given?: Given;
}

export interface EffectExpect {
  kind: string;
  match?: Record<string, unknown>;
  count: number;
}

export interface Expect {
  /** An exact status, or a matcher such as `{ gte: 400, lte: 499 }`. */
  status?: number | Record<string, unknown>;
  body?: Record<string, unknown>;
  effects?: EffectExpect[];
  latency_ms_max?: number;
}

/**
 * An outcome is declared and approved by a human, and is durable by definition:
 * every change must keep it, or a human must approve redefining or removing it.
 */
export interface Outcome {
  id: string;
  /** An outcome traces to an intent, a confirmed capability, or both. See docs/decisions/0010. */
  intent?: string;
  capability?: string;
  statement: string;
  boundary: Boundary;
  trigger: Trigger;
  conditions?: string[];
  expect: Expect;
  /** Per-condition expectations. Each field named here replaces the same field of `expect` under that condition. See docs/decisions/0004. */
  when?: Record<string, Expect>;
  constraints?: string[];
  status?: ProposalStatus;
}

/**
 * A behavior is what the runner observes the system doing. It is not durable by
 * default: drift is reported, never blocking. Promote it to an outcome to protect it.
 */
export interface Behavior {
  id: string;
  statement: string;
  capability?: string;
  boundary: Boundary;
  trigger: Trigger;
  conditions?: string[];
  /** Snapshot of what was last observed. Mismatches are drift, not failures. */
  observed?: Expect;
}

export interface Condition {
  id: string;
  statement?: string;
  given: Given;
}

export interface Constraint {
  id: string;
  statement: string;
  /** JS expression over `effects`, `state`, `response`, `request` and `db` (each table's rows after the run); must be true. */
  check: string;
  status?: ProposalStatus;
}

export interface Catalog {
  intents: Intent[];
  outcomes: Outcome[];
  behaviors: Behavior[];
  conditions: Condition[];
  constraints: Constraint[];
  /** The inventory: explains the system, never blocks. See docs/decisions/0010. */
  actors: Actor[];
  capabilities: Capability[];
  experiences: Experience[];
  unknowns: Unknown[];
  /** Changes agreed and waiting for their code, from oodlc/changes/. Never part of what runs. See docs/decisions/0012. */
  changes: Change[];
  /** id -> file it was declared in, for error messages */
  sources: Record<string, string>;
}

export interface Config {
  /** What Oodle runs. Without it the project only explains a system: intents and the inventory. See docs/decisions/0011. */
  app?: string;
  catalog: string;
  defaults?: { given?: Given };
  /** Extra conditions to probe every unknown route under, e.g. the security.* pack. Constraints are checked on each probe. */
  probe?: { conditions?: string[] };
  /**
   * The simulation is sealed by default: real network access from the app is a violation of the
   * built-in `oodle.sealed` constraint. `false` opens it; `allow` lists host or host:port pairs. See docs/decisions/0005.
   */
  sealed?: boolean | { allow?: string[] };
  /** A real Postgres for the app, simulated in process. See src/database.ts and docs/decisions/0009. */
  database?: DatabaseConfig;
}

export interface DatabaseConfig {
  /** SQL applied once before the runs: a .sql file, or a folder of migrations applied in name order. Relative to the project root. */
  schema?: string | string[];
  /** Environment variables set to the simulated database's URL. Default DATABASE_URL. */
  env?: string | string[];
}

export interface EffectRecord {
  kind: string;
  /**
   * external: crosses the system boundary (a stubbed call, an emitted effect). internal: `internal.*`, behavior only.
   * data: a row the app wrote to its own database (src/database.ts). Reported like an internal effect, never
   * changing an outcome by itself, but not internal: a constraint can tell a write happened.
   */
  boundary: 'internal' | 'external' | 'data';
  payload?: unknown;
  result?: unknown;
  error?: string;
}

export interface Observation {
  kind: 'outcome' | 'behavior';
  id: string;
  condition: string;
  status: number | null;
  body: unknown;
  effects: EffectRecord[];
  latency_ms: number;
  /** Unmet expectations. Blocking for an outcome; drift for a behavior. */
  failures: string[];
  /** Constraint breaches. Constraints hold on every run, so these always block. See docs/decisions/0002. */
  violations: string[];
  /** Breaches of proposed constraints. Reported, never blocking. See docs/decisions/0006. */
  notices: string[];
  /** A proposed outcome: its failures are reported, never blocking. */
  proposed?: true;
  error?: string;
}

export interface Gap {
  route: string;
  probe: { status: number | null; body: unknown; error?: string; effects?: EffectRecord[] };
  /** Conditions the route was probed under besides the default (config `probe.conditions`). */
  probed_under?: string[];
  /** Constraints breached while probing, prefixed "[condition] " for non-default probes. Blocking, even though nothing describes the route. */
  violations: string[];
  /** Breaches of proposed constraints while probing. Reported only. */
  notices: string[];
  /** The observed behavior, ready to add to the catalog or promote to an outcome. */
  proposal: Behavior;
}

export interface LintResult {
  errors: string[];
  warnings: string[];
}

export interface RunResult {
  projectDir: string;
  config: Config;
  catalog: Catalog;
  lint: LintResult;
  routes: string[];
  observations: Observation[];
  gaps: Gap[];
  /** Package names the project depends on directly, from package.json, for a change that rules out new dependencies. */
  dependencies?: string[];
}
