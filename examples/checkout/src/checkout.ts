import type { AppContext, Request, Response } from '../../../src/contract.ts';
import { priceCart, type LineItem } from './pricing.ts';

interface CheckoutBody { customer_id?: string; items?: LineItem[] }

export async function checkout(ctx: AppContext, req: Request): Promise<Response> {
  const body = (req.body ?? {}) as CheckoutBody;
  const customer = (ctx.state.customers ?? []).find((c: any) => c.id === body.customer_id);
  if (!customer) return { status: 404, body: { error: 'customer_not_found', message: 'We could not find your account.' } };

  const items = body.items ?? [];
  if (items.length === 0) return { status: 400, body: { error: 'cart_empty', message: 'Your cart is empty.' } };

  const { total_cents, unknown } = priceCart(ctx.state.products ?? [], items);
  if (unknown.length) return { status: 400, body: { error: 'unknown_item', message: `Some items are no longer available: ${unknown.join(', ')}` } };

  let payment: { id: string; status: string };
  try {
    payment = await ctx.effects.call('payment.capture', { customer_id: customer.id, amount_cents: total_cents });
  } catch {
    return { status: 502, body: { error: 'payment_unavailable', message: 'Payment is temporarily unavailable. No charge was made.' } };
  }
  if (payment.status !== 'succeeded') {
    return { status: 402, body: { error: 'payment_declined', message: 'Your card was declined. No charge was made.' } };
  }

  const order = { id: ctx.id('ord'), customer_id: customer.id, payment_id: payment.id, total_cents, created_at: ctx.now() };
  ctx.state.orders = [...(ctx.state.orders ?? []), order];
  customer.orders = (customer.orders ?? 0) + 1;

  ctx.effects.emit('email.sent', { to: customer.email, template: 'receipt', order_id: order.id });
  ctx.effects.emit('internal.audit', { event: 'order_created', order_id: order.id });

  return { status: 200, body: { order_id: order.id, status: 'confirmed', total_cents } };
}
