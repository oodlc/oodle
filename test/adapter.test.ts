import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import express from 'express';
import Koa from 'koa';
import { Hono } from 'hono';
import { httpApp } from '../src/adapter.ts';
import { runProject } from '../src/runner.ts';
import { seal, recordEscapes } from '../src/seal.ts';
import type { AppContext } from '../src/contract.ts';

const EXPRESS_EXAMPLE = resolve(import.meta.dirname, '..', 'examples', 'express-orders');

/** A minimal simulated context: stubbed calls answer from `stubs` and are recorded in `calls`. */
function context(stubs: Record<string, unknown> = {}, state: Record<string, any> = {}) {
  const calls: { kind: string; payload: unknown }[] = [];
  let n = 0;
  const ctx: AppContext = {
    state,
    id: (p) => `${p}_${++n}`,
    now: () => '2026-01-01T00:00:00.000Z',
    effects: {
      emit: (kind, payload) => void calls.push({ kind, payload }),
      call: async (kind, payload) => {
        calls.push({ kind, payload });
        if (!(kind in stubs)) throw new Error(`no stub for ${kind}`);
        return structuredClone(stubs[kind]) as any;
      },
    },
  };
  return { ctx, calls };
}

test('adapter: an unmodified Express service runs its outcomes, with routes found on its own', async () => {
  const run = await runProject(EXPRESS_EXAMPLE);
  assert.deepEqual(run.observations.filter((o) => o.failures.length || o.violations.length), []);
  assert.deepEqual(run.routes.sort(), ['GET /health', 'POST /orders', 'POST /orders/:id/refund']);
  assert.equal(run.gaps.length, 0);
  const paid = run.observations.find((o) => o.id === 'orders.paid-with-receipt')!;
  assert.deepEqual(paid.effects.map((e) => [e.kind, e.payload]), [
    ['payment.charge', { amount: '1800', currency: 'usd', customer: 'u1' }],
    ['email.sent', { to: 'ada@example.com', template: 'receipt', orderId: '00000000-0000-4000-8000-000000000001', amountCents: 1800 }],
  ]);
});

test('adapter: time, uuids and randomness are deterministic, so identical code gives identical output', async () => {
  const strip = (r: Awaited<ReturnType<typeof runProject>>) => r.observations.map((o) => [o.id, o.condition, o.status, o.body, o.effects]);
  assert.deepEqual(strip(await runProject(EXPRESS_EXAMPLE)), strip(await runProject(EXPRESS_EXAMPLE)));
  const body = (await runProject(EXPRESS_EXAMPLE)).observations.find((o) => o.id === 'orders.paid-with-receipt')!.body as Record<string, string>;
  assert.equal(body.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(body.id, '00000000-0000-4000-8000-000000000001');
});

test('adapter: real time and randomness come back after each request', async () => {
  const before = Date.now;
  const app = express().get('/t', (_req, res) => void res.json({ now: Date.now(), uuid: randomUUID(), r: Math.random() }));
  const { ctx } = context();
  const one = await httpApp(app)(ctx).handle({ method: 'GET', path: '/t' });
  const two = await httpApp(app)(context().ctx).handle({ method: 'GET', path: '/t' });
  assert.deepEqual(one.body, two.body);
  assert.equal((one.body as { now: number }).now, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(Date.now, before);
  assert.notEqual(new Date().getUTCFullYear(), 1970);
  assert.notEqual(randomUUID(), randomUUID());
});

test('adapter: fetch calls become effects; form, JSON and query payloads are parsed; $status sets the HTTP status', async () => {
  const app = express().use(express.json()).post('/pay', async (req, res) => {
    const r = await fetch('https://api.stripe.com/v1/charges?expand=balance', { method: 'POST', body: new URLSearchParams({ amount: String(req.body.amount) }) });
    const j = await r.json();
    await fetch('https://hooks.example.com/notify', { method: 'POST', body: JSON.stringify({ ok: r.ok }) });
    res.status(r.ok ? 200 : 402).json(j);
  });
  const create = httpApp(app, { effects: { 'api.stripe.com': 'stripe.any', 'POST api.stripe.com/v1/charges': 'payment.charge', 'hooks.example.com': 'webhook.sent' } });
  const { ctx, calls } = context({ 'payment.charge': { $status: 402, error: 'card_declined' }, 'webhook.sent': {} });
  const res = await create(ctx).handle({ method: 'POST', path: '/pay', body: { amount: 500 } });
  assert.deepEqual(res, { status: 402, headers: res.headers, body: { error: 'card_declined' } });
  assert.deepEqual(calls, [
    { kind: 'payment.charge', payload: { expand: 'balance', amount: '500' } },
    { kind: 'webhook.sent', payload: { ok: false } },
  ]);
});

test('adapter: a fetch no rule names falls through to the seal, which refuses it', async () => {
  const app = express().get('/leak', async (_req, res) => {
    try {
      await fetch('https://api.unknown.example/v1');
      res.json({ leaked: true });
    } catch {
      res.status(502).json({ leaked: false });
    }
  });
  const unseal = seal();
  try {
    const { value, escapes } = await recordEscapes(() => httpApp(app)(context().ctx).handle({ method: 'GET', path: '/leak' }));
    assert.deepEqual(value.body, { leaked: false });
    assert.deepEqual(escapes, ['api.unknown.example:443']);
  } finally {
    unseal();
  }
});

test('adapter: axios calls over node:https become effects, and a $status stub surfaces as an axios error', async () => {
  const app = express().use(express.json()).post('/pay', async (req, res) => {
    try {
      const { data } = await axios.post('https://api.stripe.com/v1/charges', new URLSearchParams({ amount: String(req.body.amount), currency: 'usd' }));
      await axios.get('https://api.sendgrid.com/v3/templates?limit=1');
      res.json({ charge: data.id });
    } catch (err: any) {
      res.status(402).json({ declined: err.response?.status, error: err.response?.data });
    }
  });
  const create = httpApp(app, { effects: { 'POST api.stripe.com/v1/charges': 'payment.charge', 'api.sendgrid.com': 'email.templates' } });

  const ok = context({ 'payment.charge': { id: 'ch_1' }, 'email.templates': { result: [] } });
  assert.deepEqual((await create(ok.ctx).handle({ method: 'POST', path: '/pay', body: { amount: 500 } })).body, { charge: 'ch_1' });
  assert.deepEqual(ok.calls, [
    { kind: 'payment.charge', payload: { amount: '500', currency: 'usd' } },
    { kind: 'email.templates', payload: { limit: '1' } },
  ]);

  const declined = context({ 'payment.charge': { $status: 402, error: { code: 'card_declined' } } });
  const res = await create(declined.ctx).handle({ method: 'POST', path: '/pay', body: { amount: 500 } });
  assert.deepEqual(res.body, { declined: 402, error: { error: { code: 'card_declined' } } });
});

test('adapter: raw http.request, captured references, piped bodies and keep-alive agents are intercepted', async () => {
  const { request } = https; // captured before the adapter patches anything, as an SDK would at import
  const agent = new https.Agent({ keepAlive: true });
  const send = (opts: https.RequestOptions, body?: Readable | string) => new Promise<{ status?: number; json: unknown }>((ok, fail) => {
    const req = request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c)).on('end', () => ok({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', fail);
    // The Stripe SDK's order: wait for the socket, then write.
    req.once('socket', (socket: any) => {
      if (socket.connecting) throw new Error('a stubbed socket is already connected');
      if (body instanceof Readable) body.pipe(req);
      else req.end(body);
    });
  });
  const app = express().get('/', async (_req, res) => {
    const a = await send({ method: 'POST', host: 'api.example.com', path: '/v1/things', agent, headers: { 'content-type': 'application/json' } }, Readable.from(['{"name":', '"widget"}']));
    const b = await new Promise<number | undefined>((ok) => http.get('http://internal.example:8080/ping', (r) => ok(r.resume().statusCode)));
    res.json({ a, b });
  });
  const { ctx, calls } = context({ 'thing.created': { id: 't1' }, 'internal.ping': { $status: 204 } });
  const out = await httpApp(app, { effects: { 'POST api.example.com/v1': 'thing.created', 'internal.example:8080': 'internal.ping' } })(ctx).handle({ method: 'GET', path: '/' });
  assert.deepEqual(out.body, { a: { status: 200, json: { id: 't1' } }, b: 204 });
  assert.deepEqual(calls, [{ kind: 'thing.created', payload: { name: 'widget' } }, { kind: 'internal.ping', payload: {} }]);
  agent.destroy();
});

test('adapter: a node:http call no rule names is still refused by the seal, and a missing stub fails the request', async () => {
  const app = express().get('/', async (_req, res) => {
    const outcome = (url: string) => axios.get(url).then(() => 'reached', (err) => err.message as string);
    res.json({ unknown: await outcome('https://api.unknown.example/v1'), unstubbed: await outcome('https://api.stripe.com/v1/balance') });
  });
  const unseal = seal();
  try {
    const { value, escapes } = await recordEscapes(() => httpApp(app, { effects: { 'api.stripe.com': 'stripe.balance' } })(context().ctx).handle({ method: 'GET', path: '/' }));
    assert.match((value.body as any).unknown, /sealed simulation/);
    assert.match((value.body as any).unstubbed, /no stub for stripe.balance/);
    assert.deepEqual(escapes, ['api.unknown.example:443']);
  } finally {
    unseal();
  }
  assert.equal(typeof (http.Agent.prototype as any).addRequest, 'function');
});

test('adapter: Koa, Hono, http.Server and a plain (req, res) handler all run', async () => {
  const koa = new Koa().use(async (c) => {
    c.body = { from: 'koa', path: c.path };
  });
  const hono = new Hono().get('/hi', (c) => c.json({ from: 'hono' })).post('/echo', async (c) => c.json(await c.req.json(), 201));
  const plain = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain');
  };
  const server = http.createServer(plain);

  const handle = (t: Parameters<typeof httpApp>[0], method: string, path: string, body?: unknown) => httpApp(t)(context().ctx).handle({ method, path, body });
  assert.deepEqual((await handle(koa, 'GET', '/k')).body, { from: 'koa', path: '/k' });
  assert.deepEqual((await handle(hono, 'GET', '/hi')).body, { from: 'hono' });
  const echoed = await handle(hono, 'POST', '/echo', { a: 1 });
  assert.equal(echoed.status, 201);
  assert.deepEqual(echoed.body, { a: 1 });
  assert.equal((await handle(plain, 'GET', '/')).body, 'plain');
  assert.equal((await handle(server, 'GET', '/')).body, 'plain');
  assert.deepEqual(httpApp(hono)(context().ctx).routes, [{ method: 'GET', path: '/hi' }, { method: 'POST', path: '/echo' }]);
  assert.deepEqual(httpApp(plain, { routes: ['get /x'] })(context().ctx).routes, [{ method: 'GET', path: '/x' }]);
});

test('adapter: setup runs once per simulated run, before the first request', async () => {
  const store = { count: 0 };
  const app = express().post('/inc', (_req, res) => void res.json({ count: ++store.count }));
  const create = httpApp(app, { setup: (ctx) => void (store.count = ctx.state.start) });
  const a = create(context({}, { start: 10 }).ctx);
  assert.deepEqual((await a.handle({ method: 'POST', path: '/inc' })).body, { count: 11 });
  assert.deepEqual((await a.handle({ method: 'POST', path: '/inc' })).body, { count: 12 });
  assert.deepEqual((await create(context({}, { start: 0 }).ctx).handle({ method: 'POST', path: '/inc' })).body, { count: 1 });
});

test('adapter: an error thrown by the app surfaces as a failed run, not a hang', async () => {
  const boom = () => {
    throw new Error('boom');
  };
  await assert.rejects(httpApp(boom)(context().ctx).handle({ method: 'GET', path: '/' }), /boom/);
  const express500 = express().get('/', () => {
    throw new Error('boom');
  });
  assert.equal((await httpApp(express500)(context().ctx).handle({ method: 'GET', path: '/' })).status, 500);
});
