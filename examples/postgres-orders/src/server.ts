// An ordinary Express service on Postgres, written with no knowledge of Oodle. See ../oodle.app.ts for how Oodle runs it.
import express from 'express';
import { pool } from './db.ts';
import { charge, refund, sendReceipt } from './payments.ts';

export const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.post('/orders', async (req, res) => {
  const { userId, items } = req.body ?? {};
  if (!Array.isArray(items) || !items.length) return void res.status(400).json({ error: 'empty_cart' });
  const { rows: [user] } = await pool.query(
    'SELECT u.id, u.email, p.discount_percent FROM users u JOIN plans p ON p.id = u.plan WHERE u.id = $1',
    [userId],
  );
  if (!user) return void res.status(404).json({ error: 'no_user' });
  const subtotal = items.reduce((s: number, i: { priceCents: number; qty: number }) => s + i.priceCents * i.qty, 0);
  const amountCents = Math.round(subtotal * (100 - user.discount_percent) / 100);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [order] } = await client.query(
      'INSERT INTO orders (user_id, amount_cents) VALUES ($1, $2) RETURNING id',
      [user.id, amountCents],
    );
    const payment = await charge(amountCents, user.id);
    if (payment.status !== 'succeeded') {
      await client.query('ROLLBACK');
      return void res.status(402).json({ error: 'payment_failed' });
    }
    const { rows: [paid] } = await client.query(
      `UPDATE orders SET status = 'paid', charge_id = $2 WHERE id = $1 RETURNING id, amount_cents AS "amountCents", status`,
      [order.id, payment.id],
    );
    await client.query('COMMIT');
    await sendReceipt(user.email, paid.id, amountCents);
    res.status(201).json(paid);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

app.post('/orders/:id/refund', async (req, res) => {
  const { rows: [order] } = await pool.query('SELECT id, charge_id, status FROM orders WHERE id = $1', [req.params.id]);
  if (!order) return void res.status(404).json({ error: 'no_order' });
  if (order.status !== 'paid') return void res.status(409).json({ error: 'not_paid' });
  await refund(order.charge_id);
  const { rows: [refunded] } = await pool.query(`UPDATE orders SET status = 'refunded' WHERE id = $1 RETURNING id, status`, [order.id]);
  res.json(refunded);
});

if (import.meta.main) app.listen(Number(process.env.PORT ?? 3000));
