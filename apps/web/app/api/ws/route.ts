import { experimental_upgradeWebSocket, type WebSocketData } from '@vercel/functions';
import { jwtVerify } from 'jose';
import { createClient } from 'redis';
import { WebSocket } from 'ws';

export const runtime = 'nodejs';
export const maxDuration = 300;

type RealtimeEnvelope = {
  event?: string;
  payload?: { roomId?: string; [key: string]: unknown };
};

type ClientState = { roomId: string | null; authenticated: boolean };

const states = new Map<WebSocket, ClientState>();
const roomSockets = new Map<string, Set<WebSocket>>();
let subscriber: ReturnType<typeof createClient> | null = null;
let subscriberPromise: Promise<void> | null = null;

function send(socket: WebSocket, value: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function unregister(socket: WebSocket) {
  const state = states.get(socket);
  states.delete(socket);
  if (!state?.roomId) return;
  const sockets = roomSockets.get(state.roomId);
  sockets?.delete(socket);
  if (!sockets?.size) roomSockets.delete(state.roomId);
}

async function ensureSubscriber() {
  if (subscriber?.isReady) return;
  if (subscriberPromise) return subscriberPromise;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is not configured.');
  subscriberPromise = (async () => {
    const next = createClient({ url: redisUrl });
    next.on('error', (error) => console.error('[realtime] Redis subscriber error', error));
    await next.connect();
    await next.pSubscribe('net:room:*', (message, channel) => {
      const roomId = channel.slice('net:room:'.length);
      const sockets = roomSockets.get(roomId);
      if (!sockets?.size) return;
      let envelope: RealtimeEnvelope;
      try {
        envelope = JSON.parse(message) as RealtimeEnvelope;
      } catch {
        return;
      }
      if (!envelope.event || envelope.payload?.roomId !== roomId) return;
      for (const socket of sockets) send(socket, { type: 'event', event: envelope.event, payload: envelope.payload });
    });
    subscriber = next as NonNullable<typeof subscriber>;
  })().catch((error) => {
    subscriber?.destroy();
    subscriber = null;
    throw error;
  }).finally(() => {
    subscriberPromise = null;
  });
  return subscriberPromise;
}

async function authenticate(socket: WebSocket, token: string) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Realtime secret is unavailable.');
  const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'net-api',
    audience: 'net-realtime',
  });
  const roomId = verified.payload.roomId;
  if (typeof verified.payload.sub !== 'string' || !['guest', 'user'].includes(String(verified.payload.kind)) || typeof roomId !== 'string') {
    throw new Error('Realtime token is invalid.');
  }
  await ensureSubscriber();
  const state = states.get(socket);
  if (!state || state.authenticated) throw new Error('Realtime socket is already authenticated.');
  state.authenticated = true;
  state.roomId = roomId;
  const sockets = roomSockets.get(roomId) ?? new Set<WebSocket>();
  sockets.add(socket);
  roomSockets.set(roomId, sockets);
  send(socket, { type: 'ready', roomId });
}

function isAllowedOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const requestUrl = new URL(request.url);
  const allowed = new Set([requestUrl.origin]);
  const configuredOrigin = process.env.WEB_ORIGIN;
  if (configuredOrigin) allowed.add(configuredOrigin.replace(/\/$/, ''));
  return allowed.has(origin.replace(/\/$/, ''));
}

export function GET(request: Request) {
  if (!isAllowedOrigin(request)) return new Response('Origin not allowed.', { status: 403 });
  return experimental_upgradeWebSocket((socket) => {
    states.set(socket, { roomId: null, authenticated: false });
    const authTimeout = setTimeout(() => socket.close(4401, 'Authentication timed out.'), 8_000);
    authTimeout.unref();

    socket.on('message', (data: WebSocketData) => {
      let message: { type?: unknown; token?: unknown };
      try {
        message = JSON.parse(data.toString()) as { type?: unknown; token?: unknown };
      } catch {
        socket.close(4400, 'Invalid message.');
        return;
      }
      if (message.type !== 'authenticate' || typeof message.token !== 'string') {
        socket.close(4401, 'Authenticate first.');
        return;
      }
      void authenticate(socket, message.token).then(() => clearTimeout(authTimeout)).catch(() => {
        socket.close(4403, 'Realtime access denied.');
      });
    });

    const close = () => {
      clearTimeout(authTimeout);
      unregister(socket);
    };
    socket.once('close', close);
    socket.once('error', close);
  }, { maxPayload: 16 * 1024 });
}
