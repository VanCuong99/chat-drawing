import { createNeonAuth } from '@neondatabase/auth/next/server';

export type AuthenticatedUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: {
    secret: process.env.NEON_AUTH_COOKIE_SECRET!,
    sessionDataTtl: 300,
  },
  logLevel: process.env.NODE_ENV === 'production' ? 'warn' : 'error',
});

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (!user?.id || !user.email) return null;
  const fullName = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : null;
  return {
    userId: user.id,
    email: user.email,
    fullName,
    displayName: fullName ?? user.email.split('@')[0],
  };
}

export function signInPath(returnTo = '/'): string {
  return `/auth/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

export function signOutPath(returnTo = '/'): string {
  return `/auth/sign-out?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

export async function createApiToken(user: AuthenticatedUser): Promise<string> {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: user.userId,
    kind: 'user',
    email: user.email,
    displayName: user.displayName,
    actorKey: `user:${user.userId}`,
    iss: 'net-web',
    aud: 'net-api',
    iat: now,
    exp: now + 60 * 60,
  }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(signature)}`;
}

export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function base64Url(value: string | ArrayBuffer) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
