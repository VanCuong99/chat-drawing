import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ActorService } from './auth/actor.service';
import { AssetsController } from './assets/assets.controller';
import { AssetsService } from './assets/assets.service';
import { StorageService } from './assets/storage.service';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { MaintenanceService } from './maintenance/maintenance.service';
import { MaintenanceController } from './maintenance/maintenance.controller';
import { DatabaseModule } from './database/database.module';
import { PaletteController } from './palette/palette.controller';
import { PaletteService } from './palette/palette.service';
import { RealtimeController } from './realtime/realtime.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeService } from './realtime/realtime.service';
import { RealtimeOutboxService } from './realtime/realtime-outbox.service';
import { RealtimeBrokerService } from './realtime/realtime-broker.service';
import { RateLimitService } from './security/rate-limit.service';
import { AbuseProtectionMiddleware } from './security/abuse-protection.middleware';
import { RequestContextMiddleware } from './observability/request-context.middleware';
import { HttpLoggingInterceptor } from './observability/http-logging.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '../../.env.local', '../../.env', '.env'],
      validate: (config: Record<string, unknown>) => {
        const secret = typeof config.AUTH_JWT_SECRET === 'string' ? config.AUTH_JWT_SECRET : '';
        if (Buffer.byteLength(secret) < 32) throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes.');
        return config;
      },
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('AUTH_JWT_SECRET'),
        signOptions: { issuer: 'net-api', audience: 'net-realtime' },
        verifyOptions: { issuer: 'net-api', audience: 'net-realtime' },
      }),
    }),
    DatabaseModule,
  ],
  controllers: [ChatController, AssetsController, RealtimeController, PaletteController, MaintenanceController],
  providers: [
    ActorService,
    RateLimitService,
    StorageService,
    AssetsService,
    RealtimeService,
    RealtimeBrokerService,
    RealtimeOutboxService,
    RealtimeGateway,
    ChatService,
    MaintenanceService,
    PaletteService,
    RequestContextMiddleware,
    AbuseProtectionMiddleware,
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
  ],
})
export class AppModule {}
