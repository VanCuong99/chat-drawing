import { NextResponse } from 'next/server';
import { auth, safeReturnTo } from '@/src/server/auth';

export async function GET(request: Request) {
  await auth.signOut();
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));
  return NextResponse.redirect(new URL(returnTo, request.url));
}
