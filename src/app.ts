/**
 * The OODLC app contract: createApp(ctx) returns { routes, handle }.
 * Send every external call through ctx.effects.call and every side effect through
 * ctx.effects.emit, and take ids and time from ctx, so Oodle can simulate the
 * world around the app and record what it does.
 */
export default function createApp(ctx: any) {
  const routes = [{ method: 'GET', path: '/health' }];
  return {
    routes,
    async handle(req: { method: string; path: string; body?: unknown }) {
      if (req.method === 'GET' && req.path === '/health') return { status: 200, body: { ok: true } };
      return { status: 404, body: { error: 'not_found' } };
    },
  };
}
