/** A spec that can't be read: every problem found, each with where it is. */
export class SpecError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.length === 1 ? (problems[0] as string) : `The spec has ${problems.length} problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'SpecError';
  }
}

/** The tier guard: something changed the declared tier that may not. */
export class TierViolation extends Error {
  constructor(readonly changes: string[]) {
    super(`Only people change the declared tier, and it changed:\n${changes.map((c) => `  - ${c}`).join('\n')}`);
    this.name = 'TierViolation';
  }
}
