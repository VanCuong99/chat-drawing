import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';

export type RealtimeEvent = 'message.created' | 'message.updated' | 'message.deleted' | 'reaction.updated' | 'messages.read' | 'guest.ended' | 'room.updated';

@Injectable()
export class RealtimeService {
  private namespace: Namespace | null = null;

  attach(namespace: Namespace) { this.namespace = namespace; }

  isReady() { return this.namespace !== null; }

  publish(roomId: string, event: RealtimeEvent, data: Record<string, unknown>) {
    this.namespace?.to(`room:${roomId}`).emit(event, { roomId, ...data });
  }

  publishActor(actorKey: string, event: RealtimeEvent, data: Record<string, unknown>) {
    this.namespace?.to(`actor:${actorKey}`).emit(event, data);
  }

  publishRoomActivity(roomId: string, actorKeys: string[], sourceEvent: RealtimeEvent, data: Record<string, unknown>) {
    if (!actorKeys.length) return;
    this.namespace?.to(actorKeys.map((actorKey) => `actor:${actorKey}`))
      .except(`room:${roomId}`)
      .emit('room.activity', { roomId, sourceEvent, ...data });
  }

  disconnectActor(actorKey: string) {
    this.namespace?.in(`actor:${actorKey}`).disconnectSockets(true);
  }
}
