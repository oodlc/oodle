const STRIPE = 'https://api.stripe.com/v1';

export async function charge(amountCents: number, customer: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`${STRIPE}/charges`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
    body: new URLSearchParams({ amount: String(amountCents), currency: 'usd', customer }),
  });
  return res.json();
}

export async function refund(chargeId: string): Promise<void> {
  const res = await fetch(`${STRIPE}/refunds`, { method: 'POST', body: new URLSearchParams({ charge: chargeId }) });
  if (!res.ok) throw new Error(`refund failed: ${res.status}`);
}

export async function sendReceipt(to: string, orderId: string, amountCents: number): Promise<void> {
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, template: 'receipt', orderId, amountCents }),
  });
}
