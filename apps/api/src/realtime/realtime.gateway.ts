import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { ActorService } from '../auth/actor.service';
import type { Actor, RealtimeClaims } from '../auth/actor.types';
import { RealtimeService } from './realtime.service';
import { telemetry } from '../observability/telemetry';
import { configInteger } from '../config/runtime-config';

type AuthenticatedSocket = Socket & { data: { actor?: Actor; authorizedRoomId?: string; activeRoomId?: string; tokenExpiresAt?: number; eventWindowStartedAt?: number; eventCount?: number } };

@WebSocketGateway({ path: '/socket.io', namespace: '/chat', transports: ['websocket'] })
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() namespace: Namespace;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly actors: ActorService,
    private readonly realtime: RealtimeService,
    private readonly config: ConfigService,
  ) {}

  afterInit(namespace: Namespace) {
    this.realtime.attach(namespace);
    namespace.use(async (client: AuthenticatedSocket, next) => {
      try {
        const token = typeof client.handshake.auth?.token === 'string' ? client.handshake.auth.token : '';
        const claims = await this.jwt.verifyAsync<RealtimeClaims>(token);
        const actor = await this.actors.resolveClaims(claims);
        if (!actor) throw new Error('Actor expired');
        const maxSockets = configInteger(this.config, 'SOCKET_MAX_CONNECTIONS_PER_ACTOR', 5, { min: 1, max: 100 });
        const actorSockets = await namespace.in(`actor:${actor.actorKey}`).fetchSockets();
        if (actorSockets.length >= maxSockets) throw new Error('Actor connection limit exceeded');
        client.data.actor = actor;
        client.data.authorizedRoomId = claims.roomId;
        client.data.tokenExpiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
        await client.join(`actor:${actor.actorKey}`);
        if (client.data.tokenExpiresAt) {
          const expirationTimer = setTimeout(() => client.disconnect(true), Math.max(0, client.data.tokenExpiresAt - Date.now()));
          expirationTimer.unref();
          client.once('disconnect', () => clearTimeout(expirationTimer));
        }
        next();
      } catch (error) {
        telemetry.socketRejected.add(1, { reason: 'handshake' });
        this.logger.warn(`Rejected socket ${client.id}: ${error instanceof Error ? error.message : 'invalid token'}`);
        next(new Error('The realtime session is invalid.'));
      }
    });
  }

  @SubscribeMessage('room.subscribe')
  async subscribe(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: { roomId?: string }) {
    const actor = client.data.actor;
    const roomId = body?.roomId;
    if (!this.consumeEvent(client)) return { ok: false, error: 'Realtime actions are being sent too quickly.' };
    if (!actor || typeof roomId !== 'string' || roomId !== client.data.authorizedRoomId) return { ok: false, error: 'The realtime session is invalid.' };
    try {
      await this.actors.assertRoomAccess(roomId, actor);
      for (const joined of client.rooms) if (joined.startsWith('room:')) await client.leave(joined);
      await client.join(`room:${roomId}`);
      client.data.activeRoomId = roomId;
      return { ok: true, roomId };
    } catch {
      return { ok: false, error: 'You do not have permission to follow this room.' };
    }
  }

  @SubscribeMessage('room.unsubscribe')
  async unsubscribe(@ConnectedSocket() client: AuthenticatedSocket) {
    if (!this.consumeEvent(client)) return { ok: false, error: 'Realtime actions are being sent too quickly.' };
    for (const joined of client.rooms) if (joined.startsWith('room:')) await client.leave(joined);
    client.data.activeRoomId = undefined;
    return { ok: true };
  }

  private consumeEvent(client: AuthenticatedSocket) {
    const now = Date.now();
    if (!client.data.eventWindowStartedAt || now - client.data.eventWindowStartedAt >= 10_000) {
      client.data.eventWindowStartedAt = now;
      client.data.eventCount = 0;
    }
    client.data.eventCount = (client.data.eventCount ?? 0) + 1;
    if (client.data.eventCount <= 50) return true;
    telemetry.socketRejected.add(1, { reason: 'event_rate' });
    return false;
  }
}
