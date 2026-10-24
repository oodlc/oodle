/**
 * The driver contract. Journeys and exploration talk to an app through actions, not routes,
 * because two builds can choose different routes. Each persona capability is an action
 * (`owner.book_walk`); the generator implements every action in `src/oodle.driver.ts`.
 *
 * A driver only gets `s.fetch`: every action goes through HTTP, as a user's would, and the
 * harness (not the driver) reads what is on the screen the action lands on. The driver is
 * generated, so a bad one could hide what the app does; keeping it to HTTP, and observing
 * outside it, is how this slice limits that.
 */

/** A persona's session: a cookie jar, and fetch bound to the app in the simulation. */
export interface Session {
  /** The fixture this session is, e.g. `owner:ada`. */
  readonly as: string;
  /** The persona user's id in the app, e.g. `ada`. */
  readonly userId: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface ActionResult {
  /** The path of the screen the user lands on. */
  screen?: string;
  /** Records the action created, so later steps can refer to them (`$walk_1` is the first walk created). */
  created?: { kind: string; id: string }[];
}

/** Inputs are plain values. A persona fixture (`walker:sam`) arrives as that user's id (`sam`); `$walk_1` arrives as the id it names. */
export type ActionInput = Record<string, unknown>;

export type Action = (s: Session, input: ActionInput) => Promise<ActionResult>;

/** A named screen: its path for a session, given params (`{ walk: 'walk_1' }`). */
export type Screen = (s: Session, params: Record<string, string>) => string;

export interface Driver {
  actions: Record<string, Action>;
  screens: Record<string, Screen>;
}
