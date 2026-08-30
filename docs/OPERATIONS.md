# Operating Nét

## Defense layers

No single Node.js or Nginx process can stop a volumetric DDoS attack that saturates the network. Production must place a CDN, WAF, or load balancer with DDoS protection in front of `infra/nginx/default.conf`. Allow ingress only from that proxy and never expose the API, PostgreSQL, Redis, or collector ports directly.

The repository mitigates application abuse and resource exhaustion in layers:

1. Nginx limits request rate, connections per IP, upload concurrency, a default 1 MB request body, an 8 MB body only on the upload endpoint, and short header/body/upstream timeouts.
2. NestJS applies a token bucket and concurrency ceiling before controller work. These limits are process-local; product write limits are checked atomically in PostgreSQL so replicas share the same state.
3. Socket.IO accepts WebSocket only, validates the exact Origin, caps buffers at 16 KiB, and limits sockets per actor and subscription-event frequency.
4. The PostgreSQL pool limits connections and sets connection, query, and statement timeouts. Transactions stay short, and outbox workers claim batches with `FOR UPDATE SKIP LOCKED`.
5. Assets have per-owner byte, count, and pending-upload limits. Vercel production must use private `STORAGE_DRIVER=blob`; a local volume is appropriate only for local development or a single Docker host.

Values in `.env.example` are a baseline, not universal limits. Tune them through representative load tests. Change limits gradually and monitor 429 rates and latency rather than guessing.

## Request IDs and logging

- Nginx accepts `X-Request-ID` only when it matches `[A-Za-z0-9._-]{8,128}`; otherwise it creates one.
- The API validates or creates a UUID, echoes `X-Request-ID`, and logs method, path without query string, status, duration, response bytes, and trace ID.
- Logs never include request bodies, authorization headers, guest tokens, signed asset tokens, or query strings.
- Production sets `LOG_FORMAT=json`; an operations-platform log agent must collect stdout/stderr and enforce retention and redaction.

Minimum alerts should cover 5xx rate, 429 rate grouped by `reason`, p95/p99 latency, active connections, PostgreSQL pool wait, outbox pending/oldest age/failures, Redis errors, asset-storage errors, memory pressure, and event-loop lag.

## Tracing and metrics

Tracing is disabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is empty. To verify the sample local collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
AUTH_JWT_SECRET="$(openssl rand -base64 48)" \
docker compose --profile observability up --build
```

The sample collector uses a memory limiter and batching, then writes summaries to logs so the pipeline is observable. In production, replace the `debug` exporter in `infra/otel/collector.yaml` with an authenticated TLS OTLP backend. Never expose port 4318 to the Internet. `OTEL_TRACES_SAMPLER_ARG=0.1` samples 10% of root traces while respecting upstream sampling decisions.

Current custom metrics:

- `net.http.rejected`
- `net.http.active`
- `net.rate_limit.rejected`
- `net.socket.rejected`
- `net.outbox.delivered`
- `net.outbox.failed`
- `net.outbox.pending`
- `net.outbox.oldest_age`
- `net.database.pool.total`, `net.database.pool.idle`, `net.database.pool.waiting`

## Realtime and multiple replicas

- Redis is mandatory when more than one API replica is running; otherwise a Socket.IO room exists in only one process.
- Every product event is inserted into `realtime_outbox` in the same data transaction. The request attempts to deliver its own event; scheduled maintenance drains the backlog in leased batches, delivers at least once, and marks rows as published. The UI must tolerate duplicates and always perform an HTTP catch-up after reconnecting.
- `message.client_request_id` is a UUID idempotency key. A retry reuses the existing key rather than creating a new key for the same send action.
- `message.sequence` is the canonical order for pagination and read state; client timestamps are never authoritative.
- Monitor unpublished outbox rows, `attempts`, `last_error`, and the oldest-row age. Published rows are removed after 24 hours.

## PostgreSQL

- Use a transaction-mode pooler when the replica/function count grows. The sum of `replicas × DATABASE_POOL_MAX` must stay below the database connection budget.
- Enable `pg_stat_statements` on the managed database to find queries with high total time, mean time, or call counts. Do not log sensitive full SQL parameters in application logs.
- Back up the database and object bucket with compatible retention, and test restoration regularly. One migration service runs before the API rollout.

## Production checklist

- A random JWT secret of at least 32 bytes comes from a secret manager; `.env` files are never committed.
- Neon Auth/OIDC uses the correct origin, and the web server never trusts identity headers supplied by the browser.
- CDN/WAF/DDoS protection, TLS, origin firewall, and health checks are enabled.
- Vercel Blob uses a private store. Its token exists only in the API, lifecycle/backup matches product retention, and raw object URLs are not public.
- Redis uses TLS/auth across networks; PostgreSQL uses TLS and a least-privilege user.
- Central JSON logs, a private OTLP collector, dashboards, alerts, and a retention budget are configured.
- `pnpm build`, `pnpm lint`, `pnpm check:i18n`, migrations, and the full E2E suite pass before rollout.
