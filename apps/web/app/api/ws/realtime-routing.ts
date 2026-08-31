export type RealtimeSocketIdentity = {
  roomId: string | null;
  actorKey: string | null;
  authenticated: boolean;
};

export type RealtimeEnvelope = {
  event?: string;
  payload?: { roomId?: string; [key: string]: unknown };
};

const ROOM_PREFIX = 'net:room:';
const ACTOR_PREFIX = 'net:actor:';

export function shouldDeliverRealtimeEnvelope(
  state: RealtimeSocketIdentity | undefined,
  channel: string,
  envelope: RealtimeEnvelope,
) {
  if (!state?.authenticated || !envelope.event || typeof envelope.payload?.roomId !== 'string') return false;
  if (channel.startsWith(ROOM_PREFIX)) {
    if (envelope.event === 'guest.requested' || envelope.event === 'guest.request.updated') return false;
    const roomId = channel.slice(ROOM_PREFIX.length);
    return roomId === state.roomId && envelope.payload.roomId === roomId;
  }
  if (channel.startsWith(ACTOR_PREFIX)) {
    const actorKey = channel.slice(ACTOR_PREFIX.length);
    return actorKey === state.actorKey;
  }
  return false;
}
