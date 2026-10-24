import type { ActionInput } from '@oodle/runtime';

/** A persona user a scenario starts with. The key it is filed under (`owner:ada`) says its persona and id. */
export interface Fixture {
  name: string;
  /** Defaults to `<id>@example.com`. */
  email?: string;
  /** Anything else the app may show: an address, a currency. */
  [field: string]: unknown;
}

/** What a step expects. Every field is optional; all given ones must hold. */
export interface Expect {
  /** Texts the observed screen shows. */
  screen_contains?: string[];
  screen_not_contains?: string[];
  /** `ok` (2xx/3xx) or `blocked` (4xx). */
  outcome?: 'ok' | 'blocked';
  /** A fixture key (`owner:ada`) that receives mail during the step. */
  mail_to?: string;
  /** No mail at all during the step. */
  no_mail?: boolean;
}

export interface Step {
  /** The prose line this step was compiled from (journeys), or a description (exploration). */
  prose?: string;
  /** Index of the prose line in the journey. Several steps can come from one line. */
  line?: number;
  /** The simulated time from this step on. */
  at?: string;
  /** Who acts: a fixture key. */
  as: string;
  /** The action, by id (`owner.book_walk`). Without one, the step only looks at a screen. */
  do?: string;
  input?: ActionInput;
  /** What to observe instead of the screen the action lands on: a named screen, maybe as someone else. */
  look?: { as?: string; screen?: string; params?: Record<string, string> };
  expect?: Expect;
}

export interface Scenario {
  /** `journey/first-booking`, `explore/collections/walks-7`… */
  id: string;
  /** When the scenario starts; the simulation's default otherwise. */
  start?: string;
  fixtures: Record<string, Fixture>;
  steps: Step[];
}

/** What a user can see on a screen. The browser path (later) must produce the same shape. */
export interface ViewModel {
  title?: string;
  headings: string[];
  /** Visible text blocks in document order, outside headings, lists, actions and fields. */
  text: string[];
  /** Order matters. */
  lists: { items: string[] }[];
  /** Visible buttons and links, by accessible name. */
  actions: string[];
  fields: { label: string; value?: string; error?: string }[];
}

/** One step, as observed. The only thing the differ compares. */
export interface Observation {
  scenario: string;
  step: number;
  /** Who was looking at the screen. */
  as: string;
  /** HTTP status of the action's final response (or of the screen, for a step with no action). */
  status: number;
  view: ViewModel;
  mail: { to: string; subject: string; text: string }[];
  /** Outbound requests the app made through the runtime. */
  outbound: { host: string; method: string }[];
  /** The action was refused (4xx). */
  blocked?: boolean;
  /** The step couldn't run: no such action, or the driver threw. */
  error?: string;
}

export interface ScenarioResult {
  scenario: string;
  observations: Observation[];
  /** Requests that went around the runtime to the network. Never allowed: the simulation is sealed. */
  escapes: { url: string; method: string }[];
}
