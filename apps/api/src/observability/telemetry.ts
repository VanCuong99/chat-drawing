import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('net-api');

export const telemetry = {
  httpRejected: meter.createCounter('net.http.rejected', { description: 'HTTP requests rejected before controller execution' }),
  httpActive: meter.createUpDownCounter('net.http.active', { description: 'Accepted HTTP requests currently in progress' }),
  durableRateLimited: meter.createCounter('net.rate_limit.rejected', { description: 'Durable per-subject rate-limit rejections' }),
  socketRejected: meter.createCounter('net.socket.rejected', { description: 'Rejected Socket.IO connections or events' }),
  outboxDelivered: meter.createCounter('net.outbox.delivered', { description: 'Realtime outbox events delivered' }),
  outboxFailed: meter.createCounter('net.outbox.failed', { description: 'Realtime outbox delivery failures' }),
  outboxPending: meter.createObservableGauge('net.outbox.pending', { description: 'Realtime outbox rows waiting to be published' }),
  outboxOldestAge: meter.createObservableGauge('net.outbox.oldest_age', { description: 'Age in milliseconds of the oldest pending realtime event', unit: 'ms' }),
  databasePoolTotal: meter.createObservableGauge('net.database.pool.total', { description: 'PostgreSQL pool clients' }),
  databasePoolIdle: meter.createObservableGauge('net.database.pool.idle', { description: 'Idle PostgreSQL pool clients' }),
  databasePoolWaiting: meter.createObservableGauge('net.database.pool.waiting', { description: 'Requests waiting for a PostgreSQL pool client' }),
};
