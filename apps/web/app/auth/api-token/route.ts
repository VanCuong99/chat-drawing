import { createApiToken, getAuthenticatedUser } from '@/src/server/auth';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error: 'Your sign-in session is no longer valid.' }, { status: 401 });
  return Response.json({ token: await createApiToken(user) });
}
