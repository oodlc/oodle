/** Bindings and vars from wrangler.jsonc (and .dev.vars locally). */
export type Env = {
  DB: D1Database;
  /** The built web app (Workers static assets). Absent in tests. */
  ASSETS?: Fetcher;
  /** `<team>.cloudflareaccess.com`: where Access publishes its signing keys. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** "1" turns on the X-Oodle-Dev-Email identity override. Never set in production. */
  DEV_AUTH?: string;
  /** With DEV_AUTH, the identity to use when the request carries no override header. */
  DEV_EMAIL?: string;
};

export type Vars = {
  /** Set by Access (or the dev override) on /api/ui/*. */
  email: string;
  /** Set by token auth on /api/v1/*. */
  tokenId: string;
};

export type AppEnv = { Bindings: Env; Variables: Vars };

/** An error the API turns into a JSON response: `{ error, message, ...extra }`. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
