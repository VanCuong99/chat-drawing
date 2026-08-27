import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import type { IncomingMessage } from 'node:http';
import type { ServerOptions } from 'socket.io';

export class SocketIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private clients: RedisClientType[] = [];
  private readonly logger = new Logger(SocketIoAdapter.name);

  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
    private readonly allowNoOrigin: boolean,
  ) { super(app); }

  async connect(redisUrl: string) {
    const publisher = createClient({ url: redisUrl });
    const subscriber = publisher.duplicate();
    publisher.on('error', (error) => this.logger.error({ event: 'redis.publisher.error', message: error.message }));
    subscriber.on('error', (error) => this.logger.error({ event: 'redis.subscriber.error', message: error.message }));
    await Promise.all([publisher.connect(), subscriber.connect()]);
    this.clients = [publisher, subscriber];
    this.adapterConstructor = createAdapter(publisher, subscriber);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      transports: ['websocket'],
      serveClient: false,
      allowEIO3: false,
      connectTimeout: 10_000,
      maxHttpBufferSize: 16 * 1024,
      perMessageDeflate: false,
      httpCompression: false,
      cors: { origin: this.allowedOrigins, credentials: false },
      allowRequest: (request: IncomingMessage, callback: (error: string | null | undefined, success: boolean) => void) => {
        const origin = request.headers.origin;
        callback(null, typeof origin === 'string' ? this.allowedOrigins.includes(origin) : this.allowNoOrigin);
      },
    });
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async dispose() { await Promise.allSettled(this.clients.map((client) => client.quit())); }
}
