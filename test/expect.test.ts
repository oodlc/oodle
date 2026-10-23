import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate, matchValue } from '../src/expect.ts';
import { runProject } from '../src/runner.ts';

const ADAPTER = pathToFileURL(resolve(import.meta.dirname, '..', 'src', 'adapter.ts')).href;

test('matchers: contains takes a list, not_contains and not refuse what they name', () => {
  assert.equal(matchValue('<h1>Library</h1>', { contains: ['Library', '<h1>'] }), null);
  assert.match(matchValue('<h1>Library</h1>', { contains: ['Library', 'Queue'] })!, /expected to contain "Queue"/);
  assert.equal(matchValue('<p>live card</p>', { not_contains: ['queued', 'draft'] }), null);
  assert.match(matchValue('<p>queued card</p>', { not_contains: ['queued', 'draft'] })!, /expected not to contain "queued"/);
  assert.equal(matchValue(undefined, { not_contains: 'x' }), null, 'an absent header contains nothing');
  assert.equal(matchValue(401, { not: 200 }), null);
  assert.match(matchValue(200, { not: 200 })!, /expected not 200/);
  assert.match(matchValue(204, { not: { gte: 200, lte: 299 } })!, /expected not/);
  // A long page is clipped around what was found, not printed whole.
  assert.ok(matchValue(`${'x'.repeat(500)} draft ${'y'.repeat(500)}`, { not_contains: 'draft' })!.length < 200);
});

test('evaluate: headers by any case, and the whole body as text', () => {
  const obs = { status: 302, body: '<title>Sign in</title>', headers: { location: '/login', 'set-cookie': 'sid=1; HttpOnly' }, effects: [], latency_ms: 0 };
  assert.deepEqual(evaluate({ headers: { Location: '/login', 'set-cookie': { contains: 'HttpOnly' } }, text: { contains: 'Sign in' } }, obs), []);
  assert.deepEqual(evaluate({ headers: { location: '/' }, text: { not_contains: 'Sign' } }, obs), [
    'headers.location: expected "/", got "/login"',
    'text: expected not to contain "Sign", got "<title>Sign in</title>"',
  ]);
  assert.deepEqual(evaluate({ headers: { 'x-missing': { exists: false } }, text: '{"ok":true}' }, { ...obs, body: { ok: true } }), []);
});

/** A fetch-style app (a Worker's shape) that reads its host from the URL and answers pages and redirects. */
function siteProject(app: string, outcomes: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oodle-expect-'));
  mkdirSync(join(dir, 'oodlc'));
  writeFileSync(join(dir, 'oodlc', 'config.yaml'), 'app: app.mjs\n');
  writeFileSync(join(dir, 'oodlc', 'site.yaml'), `version: 0\nintents: [{ id: readers, statement: Readers see only live cards }]\n${outcomes}`);
  writeFileSync(join(dir, 'app.mjs'), `import { httpApp } from '${ADAPTER}';\n${app}`);
  return dir;
}

const APP = `export default httpApp({
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/admin') return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': 'next=/admin; HttpOnly' } });
    if (url.hostname === 'engine.example.com') return new Response('engine', { status: 200 });
    return new Response('<html><title>Library</title><p>live card</p></html>', { headers: { 'content-type': 'text/html' } });
  },
}, { routes: ['GET /', 'GET /admin'] });
`;

const OUTCOMES = `outcomes:
  - id: admin.redirects
    intent: readers
    refs: [B-064]
    statement: A logged-out visitor to /admin is sent to the login page
    boundary: external
    trigger: { http: GET /admin }
    expect:
      status: 302
      headers: { Location: /login, set-cookie: { contains: HttpOnly } }
  - id: library.live-only
    intent: readers
    refs: [B-138]
    statement: The library shows no queued or draft card
    boundary: external
    trigger: { http: GET / }
    expect:
      status: 200
      headers: { content-type: { contains: text/html } }
      text: { contains: Library, not_contains: [queued, draft] }
  - id: engine.by-host
    intent: readers
    statement: The engine host answers for itself
    boundary: external
    trigger: { http: GET /, given: { headers: { host: engine.example.com } } }
    expect: { status: 200, text: engine }
constraints:
  - id: no-cookie-on-pages
    statement: A page never sets a cookie
    check: "response.status !== 200 || !response.headers['set-cookie']"
`;

test('run: headers, text and the request host are checked, and constraints see response headers', async () => {
  const run = await runProject(siteProject(APP, OUTCOMES));
  assert.deepEqual(run.observations.flatMap((o) => [...o.failures, ...o.violations]), []);
  assert.deepEqual(run.catalog.outcomes.map((o) => o.refs), [['B-064'], ['B-138'], undefined]);
  // Headers are checked, not kept: the report stays status, body and effects.
  assert.equal('headers' in run.observations[0], false);

  const leaky = APP.replace('<p>live card</p>', '<p>queued card</p>').replace("'content-type': 'text/html'", "'content-type': 'text/html', 'set-cookie': 'a=1'").replace("location: '/login'", "location: '/'");
  const broken = await runProject(siteProject(leaky, OUTCOMES));
  const of = (id: string) => broken.observations.find((o) => o.id === id)!;
  assert.deepEqual(of('admin.redirects').failures, ['headers.location: expected "/login", got "/"']);
  assert.match(of('library.live-only').failures.join('\n'), /text: expected not to contain "queued"/);
  assert.match(of('library.live-only').violations.join('\n'), /no-cookie-on-pages violated/);
});
