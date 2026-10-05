// Real HTTP server for local use: `npx tsx examples/checkout/src/server.ts`.
// The runner never uses this file; it calls createApp() in-process.
import { createServer } from 'node:http';
import createApp from './app.ts';

const state = {
  products: [{ sku: 'tee', name: 'T-shirt', price_cents: 2500 }],
  customers: [{ id: 'c1', email: 'ada@example.com', orders: 0 }],
};
let n = 0;
const app = createApp({
  state,
  id: (p) => `${p}_${++n}`,
  now: () => new Date().toISOString(),
  effects: {
    emit: (kind, payload) => console.log('effect', kind, payload),
    call: async (kind, payload) => {
      console.log('call', kind, payload);
      return { id: `pay_${++n}`, status: 'succeeded' } as any;
    },
  },
});

createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const out = await app.handle({ method: req.method ?? 'GET', path: req.url ?? '/', body: raw ? JSON.parse(raw) : undefined });
  res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
}).listen(3000, () => console.log('checkout demo on http://localhost:3000'));
