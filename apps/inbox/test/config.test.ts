import { describe, expect, it } from 'vitest';
import wranglerConfig from '../wrangler.jsonc?raw';
import { call } from './helpers.ts';

/** wrangler.jsonc without comments. Strings in it hold no "//" or "/*", which the first assertion guards. */
function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
}

describe('production config', () => {
  const config = parseJsonc(wranglerConfig);

  it('never enables the dev identity override', () => {
    expect(config.name).toBe('oodle-inbox');
    const envs = [config, ...Object.values((config.env ?? {}) as Record<string, Record<string, unknown>>)];
    for (const e of envs) {
      const vars = (e.vars ?? {}) as Record<string, unknown>;
      expect(vars.DEV_AUTH).toBeUndefined();
      expect(vars.DEV_EMAIL).toBeUndefined();
    }
    expect(wranglerConfig).not.toMatch(/"DEV_AUTH"\s*:/);
  });

  it('serves the web app as assets and keeps /api on the Worker', () => {
    const assets = config.assets as Record<string, unknown>;
    expect(assets.directory).toBe('./dist/web');
    expect(assets.run_worker_first).toEqual(['/api/*']);
  });
});

describe('static routes', () => {
  it('redirects / to the app', async () => {
    const res = await call('GET', '/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/app/');
  });

  it('answers unknown /app paths with the app index (SPA fallback)', async () => {
    const seen: string[] = [];
    const ASSETS = {
      fetch: async (input: RequestInfo | URL) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response('<!doctype html><div id="root"></div>', { headers: { 'Content-Type': 'text/html' } });
      },
      connect: () => {
        throw new Error('not used');
      },
    } as unknown as Fetcher;
    const res = await call('GET', '/app/p/dogwalk/gaps/g_1', { env: { ASSETS } });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['https://inbox.test/app/']);
  });

  it('gives unknown API paths a JSON 404', async () => {
    const res = await call('GET', '/api/v2/nothing');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not_found');
  });
});
