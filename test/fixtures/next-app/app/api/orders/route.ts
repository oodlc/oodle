import { NextResponse, type NextRequest } from 'next/server';
import { db } from '../../_lib/store';

export async function GET(req: NextRequest) {
  const paid = req.nextUrl.searchParams.get('paid');
  const orders = [...db.orders.values()].filter((o) => paid === null || String(o.paid) === paid);
  return NextResponse.json({ orders });
}

export async function POST(req: Request) {
  const { sku } = await req.json();
  if (!sku) return NextResponse.json({ error: 'sku_required' }, { status: 400 });
  const charge = await fetch('https://api.payments.test/v1/charges', { method: 'POST', body: JSON.stringify({ sku, amount: 2500 }) });
  const { id } = await charge.json();
  const order = { id: `ord_${crypto.randomUUID().slice(-4)}`, sku, paid: id === 'ch_ok' };
  db.orders.set(order.id, order);
  return NextResponse.json(order, { status: 201 });
}
