import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/manifest.webmanifest', '/sw.js', '/offline', '/icons'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/')) || pathname.startsWith('/_next') || pathname.startsWith('/api') || pathname.startsWith('/webhooks')) return NextResponse.next();
  const hasSession = Boolean(req.cookies.get('bays_acq_session')?.value);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (pathname === '/') { const url = req.nextUrl.clone(); url.pathname = '/dashboard'; return NextResponse.redirect(url); }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
