import { getRequestLanguage } from '@/src/i18n/server';

type InviteRoomPreview = {
  name: string;
  hostedBy: string | null;
  participantCount: number;
};

function inviteCodeFromReturnTo(returnTo: string) {
  try {
    return new URL(returnTo, 'https://net.local').searchParams.get('room')?.trim() ?? '';
  } catch {
    return '';
  }
}

export default async function AuthInviteContext({ returnTo }: { returnTo: string }) {
  const inviteCode = inviteCodeFromReturnTo(returnTo);
  if (!inviteCode) return null;
  const apiOrigin = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  let room: InviteRoomPreview | null = null;
  try {
    const response = await fetch(`${apiOrigin}/api/invites/${encodeURIComponent(inviteCode)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { room?: InviteRoomPreview };
    room = payload.room ?? null;
  } catch {
    return null;
  }
  if (!room) return null;
  const { t } = await getRequestLanguage();
  return (
    <aside className="auth-invite-context" aria-label={t('Invitation context')}>
      <small>{t('You are signing in to join')}</small>
      <strong>{room.name}</strong>
      <span>{room.hostedBy
        ? t('Hosted by {name} · {count} people', { name: room.hostedBy, count: room.participantCount })
        : t('{count} people in this creative thread', { count: room.participantCount })}</span>
    </aside>
  );
}
