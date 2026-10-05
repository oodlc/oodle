// An ordinary Express service, written with no knowledge of Oodle. See ../oodle.app.ts for how Oodle runs it.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { store } from './repo.ts';
import { charge, refund, sendReceipt } from './payments.ts';

export const app = express();
app.use(express.json());

const total = (items: { priceCents: number; qty: number }[], plan: string) => {
  const sub = items.reduce((s, i) => s + i.priceCents * i.qty, 0);
  return plan === 'pro' ? Math.round(sub * 0.9) : sub;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/orders', async (req, res) => {
  const { userId, items } = req.body ?? {};
  if (!Array.isArray(items) || !items.length) return void res.status(400).json({ error: 'empty_cart' });
  const user = store.users.get(userId);
  if (!user) return void res.status(404).json({ error: 'no_user' });
  const amountCents = total(items, user.plan);
  const payment = await charge(amountCents, user.id);
  if (payment.status !== 'succeeded') return void res.status(402).json({ error: 'payment_failed' });
  const order = { id: randomUUID(), userId, amountCents, chargeId: payment.id, status: 'paid' as const, createdAt: new Date().toISOString() };
  store.orders.set(order.id, order);
  await sendReceipt(user.email, order.id, amountCents);
  res.status(201).json(order);
});

app.post('/orders/:id/refund', async (req, res) => {
  const order = store.orders.get(req.params.id);
  if (!order) return void res.status(404).json({ error: 'no_order' });
  await refund(order.chargeId);
  order.status = 'refunded';
  res.json(order);
});

if (import.meta.main) app.listen(Number(process.env.PORT ?? 3000));
