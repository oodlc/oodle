import type { AppContext, OodleApp, Request, Response } from '../../../src/contract.ts';
import { checkout } from './checkout.ts';

type Handler = (ctx: AppContext, req: Request, params: Record<string, string>) => Promise<Response>;

export default function createApp(ctx: AppContext): OodleApp {
  const table: { method: string; path: string; handler: Handler }[] = [
    { method: 'GET', path: '/health', handler: async () => ({ status: 200, body: { ok: true } }) },
    { method: 'POST', path: '/checkout', handler: checkout },
  ];

  const match = (pattern: string, path: string): Record<string, string> | null => {
    const a = pattern.split('/');
    const b = path.split('?')[0].split('/');
    if (a.length !== b.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) return null;
    }
    return params;
  };

  return {
    routes: table.map(({ method, path }) => ({ method, path })),
    async handle(req) {
      for (const r of table) {
        const params = r.method === req.method ? match(r.path, req.path) : null;
        if (params) return r.handler(ctx, req, params);
      }
      return { status: 404, body: { error: 'not_found' } };
    },
  };
}
