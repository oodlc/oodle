import { env as sharedEnv } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import footer from './footer.md';

interface Env {
  DB: any;
  FLAGS: any;
  EMAIL: { send(message: EmailMessage): Promise<void> };
  MCP_TOKEN: string;
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const page = (title: string, body: string) =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === 'engine.cards.example') return Response.json({ engine: true, site: sharedEnv.SITE_NAME });

    if (url.pathname === '/library') {
      const { results } = await env.DB.prepare("SELECT title FROM cards WHERE status = 'live' ORDER BY id").all();
      const list = results.map((c: { title: string }) => `<li>${c.title}</li>`).join('');
      // The footer goes in on the way out, as it does in production.
      return new HTMLRewriter()
        .on('main', { element: (el) => el.append(`<footer>${footer}</footer>`, { html: true }) })
        .transform(page('Library', `<h1>Library</h1><ul>${list}</ul>`));
    }

    if (url.pathname === '/admin') {
      if (!/(^|;\s*)session=/.test(req.headers.get('cookie') ?? '')) return new Response(null, { status: 302, headers: { location: '/login' } });
      return page('Admin', '<h1>Admin</h1>');
    }

    if (url.pathname === '/signup' && req.method === 'POST') {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) return Response.json({ error: 'cross_site' }, { status: 403 });
      const body = (await req.json()) as { email?: string; website?: string };
      // The honeypot: a person never fills it in.
      if (body.website) return Response.json({ ok: true });
      if (!body.email?.includes('@')) return Response.json({ error: 'invalid_email' }, { status: 400 });
      await env.DB.prepare('INSERT INTO signups (email) VALUES (?)').bind(body.email).run();
      ctx.waitUntil(env.EMAIL.send(new EmailMessage('hello@cards.example', body.email, 'Subject: Welcome to Cards\r\n\r\nThanks for signing up.')));
      return Response.json({ ok: true }, { status: 201 });
    }

    if (url.pathname === '/mcp') {
      const auth = req.headers.get('authorization');
      if (!auth) return new Response('Not found', { status: 404 });
      const enc = new TextEncoder();
      const given = enc.encode(auth.replace(/^Bearer /, ''));
      const want = enc.encode(env.MCP_TOKEN);
      if (given.byteLength !== want.byteLength || !crypto.subtle.timingSafeEqual(given, want)) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ ok: true });
    }

    if (url.pathname === '/flags') return Response.json({ beta: (await env.FLAGS.get('beta')) === 'on' });

    return new Response('Not found', { status: 404 });
  },
};
