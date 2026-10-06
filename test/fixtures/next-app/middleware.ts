import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  if (req.headers.get('x-block')) return NextResponse.json({ error: 'blocked' }, { status: 403 });
  if (req.nextUrl.pathname === '/api/old-hello') return NextResponse.rewrite(new URL('/api/hello', req.url));
  const headers = new Headers(req.headers);
  headers.set('x-from-middleware', 'yes');
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('x-seen-by-middleware', req.nextUrl.pathname);
  return res;
}

export const config = { matcher: ['/api/:path*'] };
