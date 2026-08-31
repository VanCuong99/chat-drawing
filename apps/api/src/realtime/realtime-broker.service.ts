import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import type { RealtimeEvent } from './realtime.service';

const CHANNEL_PREFIX = 'net:room:';
const ACTOR_CHANNEL_PREFIX = 'net:actor:';

@Injectable()
export class RealtimeBrokerService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeBrokerService.name);
  private client: RedisClientType | null = null;
  private connectPromise: Promise<RedisClientType | null> | null = null;

  constructor(private readonly config: ConfigService) {}

  async publish(roomId: string, event: RealtimeEvent, payload: Record<string, unknown>) {
    const client = await this.connectedClient();
    if (!client) return;
    await client.publish(`${CHANNEL_PREFIX}${roomId}`, JSON.stringify({ event, payload: { roomId, ...payload } }));
  }

  async publishActors(actorKeys: string[], roomId: string, event: RealtimeEvent, payload: Record<string, unknown>) {
    if (!actorKeys.length) return;
    const client = await this.connectedClient();
    if (!client) return;
    const message = JSON.stringify({ event, payload: { roomId, ...payload } });
    await Promise.all([...new Set(actorKeys)].map((actorKey) => client.publish(`${ACTOR_CHANNEL_PREFIX}${actorKey}`, message)));
  }

  async onModuleDestroy() {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    if (client?.isOpen) await client.quit().catch(() => client.destroy());
  }

  private async connectedClient() {
    if (this.client?.isReady) return this.client;
    if (this.connectPromise) return this.connectPromise;
    const url = this.config.get<string>('REDIS_URL');
    if (!url) return null;
    this.connectPromise = (async () => {
      const client = createClient({ url });
      client.on('error', (error) => this.logger.warn(`Redis realtime publisher error: ${error.message}`));
      try {
        await client.connect();
        this.client = client as RedisClientType;
        return this.client;
      } catch (error) {
        client.destroy();
        this.logger.warn(`Redis realtime publisher unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
        return null;
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }
}
