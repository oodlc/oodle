// How Oodle runs the Worker: its own fetch handler, in process, with env built from wrangler.jsonc.
// D1 is the SQLite database `database` in oodlc/config.yaml names; email, KV and assets are simulated.
import { workerApp } from '@oodlc/oodle/workers';

export default await workerApp(() => import('./src/index.ts'), {
  wrangler: new URL('./wrangler.jsonc', import.meta.url),
  routes: ['GET /library', 'GET /admin', 'POST /signup', 'POST /mcp', 'GET /flags'],
  env: { MCP_TOKEN: 'test-token' },
});
