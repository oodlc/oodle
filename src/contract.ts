/**
 * The app contract. A greenfield app built for OODLC exports a
 * `createApp(ctx)` factory. Everything that crosses the system boundary
 * (payments, email, third-party APIs) goes through `ctx.effects`, and every
 * source of non-determinism (ids, time) goes through `ctx`. That is what lets
 * the runner simulate the world around the app and record what it does.
 */

export interface Request {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Response {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Effects {
  /** Fire-and-forget side effect, e.g. `email.sent`. Kinds starting with `internal.` are behavior only and never affect an outcome. */
  emit(kind: string, payload?: Record<string, unknown>): void;
  /** Request/response call to something outside the system, e.g. `payment.capture`. */
  call<T = any>(kind: string, payload?: Record<string, unknown>): Promise<T>;
}

export interface AppContext {
  effects: Effects;
  /** The app's store. Seeded per run from the outcome or behavior conditions. */
  state: Record<string, any>;
  /** Deterministic id generator: id('ord') -> 'ord_1', 'ord_2', ... */
  id(prefix: string): string;
  /** Deterministic clock. */
  now(): string;
}

export interface Route {
  method: string;
  path: string;
}

export interface OodleApp {
  routes: Route[];
  handle(req: Request): Promise<Response>;
}

export type CreateApp = (ctx: AppContext) => OodleApp;
