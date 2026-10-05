/**
 * Errors a person can act on. Every OodleError carries a stable `code` (for
 * scripts and agents), a plain message, and when possible a `hint` that says
 * what to do next. Anything else reaching the top level is treated as a bug.
 */

/** Documented exit codes. Keep in sync with `oodle help` and docs/cli.md. */
export const EXIT = {
  ok: 0,
  /** Something a human declared is not holding: an outcome, a constraint, or catalog lint. */
  blocking: 1,
  /** The command could not run: bad usage, missing project, invalid config, app failed to load. */
  usage: 2,
  /** Interrupted with Ctrl-C (128 + SIGINT). */
  interrupted: 130,
} as const;

export class OodleError extends Error {
  code: string;
  hint?: string;
  problems: string[];
  exitCode: number;
  constructor(code: string, message: string, opts: { hint?: string; problems?: string[]; exitCode?: number } = {}) {
    super(message);
    this.code = code;
    this.hint = opts.hint;
    this.problems = opts.problems ?? [];
    this.exitCode = opts.exitCode ?? EXIT.usage;
  }
}

export const usageError = (message: string, hint?: string) => new OodleError('usage', message, { hint });

/** Optimal string alignment distance: Levenshtein plus adjacent swaps, so "rnu" finds "run". */
export function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

export function suggest(input: string, candidates: string[]): string | undefined {
  const scored = candidates
    .map((c) => ({ c, d: c.startsWith(input) && input.length >= 2 ? 0.5 : distance(input, c) }))
    .filter(({ c, d }) => d <= Math.max(1, Math.floor(c.length / 3)))
    .sort((a, b) => a.d - b.d);
  return scored[0]?.c;
}
