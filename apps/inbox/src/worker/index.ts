import { Hono } from 'hono';
import { ApiError, type AppEnv, type Env } from './env.ts';
import { sync } from './sync.ts';
import { ui } from './ui.ts';

/**
 * The inbox Worker (section 10): /api/v1 for the CLI (project tokens), /api/ui for people
 * (Cloudflare Access), /app for the web app (static assets).
 */
export const app = new Hono<AppEnv>()
  .route('/api/v1', sync)
  .route('/api/ui', ui)
  .get('/', (c) => c.redirect('/app/', 302))
  // Assets that exist are served before the Worker runs. Anything else under /app is a client
  // route, so it gets the app's index.
  .get('/app/*', async (c) => {
    if (!c.env.ASSETS) return c.text('The web app is not built. Run `pnpm build` in apps/inbox.', 404);
    return c.env.ASSETS.fetch(new URL('/app/', c.req.url));
  })
  .notFound((c) => c.json({ error: 'not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}.` }, 404))
  .onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
    console.error(err);
    return c.json({ error: 'internal', message: 'Something went wrong in the inbox.' }, 500);
  });

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
