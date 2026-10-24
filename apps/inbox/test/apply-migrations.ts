import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs before each test file. Already-applied migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
