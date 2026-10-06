import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { db } from '../../../_lib/store';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await cookies()).get('session')) return Response.json({ error: 'sign_in' }, { status: 401 });
  const order = db.orders.get((await params).id);
  if (!order) notFound();
  return Response.json(order);
}

export const DELETE = async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  db.orders.delete((await params).id);
  return new Response(null, { status: 204 });
};
