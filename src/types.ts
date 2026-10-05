export const BOUNDARIES = ['customer', 'external', 'data', 'obligation', 'internal'] as const;
export type Boundary = (typeof BOUNDARIES)[number];

export interface Intent {
  id: string;
  statement: string;
}

export interface Stub {
  result?: unknown;
  error?: string;
  latency_ms?: number;
}

export interface Given {
  body?: unknown;
  state?: Record<string, unknown>;
  stubs?: Record<string, Stub>;
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
  status?: number;
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
  intent?: string;
  statement: string;
  boundary: Boundary;
  trigger: Trigger;
  conditions?: string[];
  expect: Expect;
  constraints?: string[];
}

/**
 * A behavior is what the runner observes the system doing. It is not durable by
 * default: drift is reported, never blocking. Promote it to an outcome to protect it.
 */
export interface Behavior {
  id: string;
  statement: string;
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
  /** JS expression over `effects`, `state`, `response`; must be true. */
  check: string;
}

export interface Catalog {
  intents: Intent[];
  outcomes: Outcome[];
  behaviors: Behavior[];
  conditions: Condition[];
  constraints: Constraint[];
  /** id -> file it was declared in, for error messages */
  sources: Record<string, string>;
}

export interface Config {
  app: string;
  catalog: string;
  defaults?: { given?: Given };
}

export interface EffectRecord {
  kind: string;
  boundary: 'internal' | 'external';
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
  error?: string;
}

export interface Gap {
  route: string;
  probe: { status: number | null; body: unknown; error?: string };
  /** Constraints breached while probing. Blocking, even though nothing describes the route. */
  violations: string[];
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
}
