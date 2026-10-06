import { headers } from 'next/headers';

export async function GET() {
  return Response.json({ greeting: process.env.GREETING, via: (await headers()).get('x-from-middleware') });
}
