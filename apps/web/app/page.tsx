import { createApiToken, getAuthenticatedUser, signInPath, signOutPath } from '@/src/server/auth';
import NetApp from '@/src/features/chat/net-app';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams?: Promise<{ room?: string | string[] }> }) {
  const parameters = await searchParams;
  const roomParameter = Array.isArray(parameters?.room) ? parameters.room[0] : parameters?.room;
  const inviteCode = typeof roomParameter === 'string' && /^[A-Za-z0-9]{4,60}$/.test(roomParameter)
    ? roomParameter
    : '';
  const returnTo = inviteCode ? `/?room=${encodeURIComponent(inviteCode)}` : '/';
  const user = await getAuthenticatedUser();
  const apiToken = user ? await createApiToken(user) : null;
  return (
    <NetApp
      initialUser={user ? { id: user.userId, displayName: user.displayName, email: user.email } : null}
      initialApiToken={apiToken}
      signInPath={signInPath(returnTo)}
      signOutPath={signOutPath('/')}
    />
  );
}
