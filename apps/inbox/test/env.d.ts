import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ACCESS_TEAM_DOMAIN: string;
      ACCESS_AUD: string;
      DEV_AUTH?: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
