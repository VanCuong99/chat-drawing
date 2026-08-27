import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssetsService } from '../assets/assets.service';
import { ChatService } from '../chat/chat.service';
import { RateLimitService } from '../security/rate-limit.service';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service';

@Injectable()
export class MaintenanceService {
  private running = false;
  constructor(
    private readonly chat: ChatService,
    private readonly assets: AssetsService,
    private readonly limits: RateLimitService,
    private readonly outbox: RealtimeOutboxService,
  ) {}

  @Cron('0 * * * * *')
  async cleanup() {
    if (this.running) return;
    this.running = true;
    try {
      await this.chat.cleanupExpiredGuests();
      await this.assets.cleanupOrphans();
      await this.limits.cleanup();
      await this.outbox.cleanup();
    } finally {
      this.running = false;
    }
  }
}
