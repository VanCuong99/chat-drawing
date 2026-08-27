import { chatGPTSignInPath, chatGPTSignOutPath, createApiToken, getChatGPTUser } from '@/src/server/chatgpt-auth';
import NetApp from '@/src/features/chat/net-app';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getChatGPTUser();
  const apiToken = user ? await createApiToken(user) : null;
  return (
    <NetApp
      initialUser={user ? { id: user.userId, displayName: user.displayName, email: user.email } : null}
      initialApiToken={apiToken}
      signInPath={chatGPTSignInPath('/')}
      signOutPath={chatGPTSignOutPath('/')}
    />
  );
}
