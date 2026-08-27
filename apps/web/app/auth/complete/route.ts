import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, safeReturnTo } from '@/src/server/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  if (await getAuthenticatedUser()) {
    return NextResponse.redirect(new URL(returnTo, request.url));
  }

  const params = new URLSearchParams({
    returnTo,
    error: 'Phiên đăng nhập chưa được tạo. Vui lòng thử đăng nhập lại.',
  });
  return NextResponse.redirect(new URL(`/auth/sign-in?${params.toString()}`, request.url));
}
