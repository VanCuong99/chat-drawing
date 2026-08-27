import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RealtimeOutboxService } from './realtime-outbox.service';

@Injectable()
export class RealtimeOutboxWorker {
  constructor(private readonly outbox: RealtimeOutboxService) {}

  @Interval(1_000)
  async deliverPending() { await this.outbox.drain(); }
}
