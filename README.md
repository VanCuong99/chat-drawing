# Nét

Nét is a messenger for sharing text, images, and versioned drawings. The repository is a pnpm workspace with a Next.js frontend, a NestJS backend, PostgreSQL through Drizzle ORM, and Socket.IO realtime messaging.

Nét Studio includes an approximate Kubelka–Munk pigment mixer for 2–12 component colors. A person assigns parts to each color, sees normalized proportions, saves the complete formula, and can reload it for further editing. Each personal palette stores up to 24 formulas. The `spectral-kubelka-munk-rgb` v2 model reverses the factor/luminance transform used by spectral.js so the UI ratios enter the simultaneous mixture as the declared concentrations. It remains an sRGB/D65 approximation; a physical paint recipe requires measured K/S spectra for each pigment, binder, substrate, and lighting condition.

The fill tool offers Solid, Marker, Colored Pencil, Watercolor, and Gouache materials. Natural materials use deterministic texture seeds, paper grain, granulation, material-specific coverage, water dilution, and watercolor edge pooling. Undo, redo, and export therefore reproduce the same result. This is an interaction-focused web-canvas model, not a laboratory material model or a fluid-dynamics simulation.

## Architecture

```text
apps/web/                    Next.js App Router web client + Neon Auth
apps/api/                    NestJS REST API + Socket.IO gateway
packages/database/           Drizzle schema, client, and PostgreSQL migrations
packages/pigment/            shared multi-pigment mixing model
tests/e2e/                   browser-flow and realtime tests
infra/nginx/                 reverse proxy and rate/connection limits
infra/otel/                  sample local OpenTelemetry Collector
scripts/                     scoped workspace maintenance commands
```

Each directory has one responsibility. The frontend no longer lives at the repository root, and `packages/database/drizzle/` is the only migration source. `pnpm clean` removes only reproducible build/test output and does not touch local uploads.

PostgreSQL is the source of truth for product data, distributed rate limits, and the transactional realtime outbox. Local image files live in the API volume; production requires `STORAGE_DRIVER=blob` with a private Vercel Blob store. PostgreSQL retains metadata and ownership while the API issues short-lived, actor-and-room-scoped read URLs. The Redis adapter synchronizes Socket.IO across NestJS instances, and the production API refuses to start without `REDIS_URL`.

## Local development

Requires Node.js 22+, pnpm 10, and PostgreSQL. When Docker is available, the quickest setup is:

```bash
cp .env.example .env.local
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

Set `NEON_AUTH_BASE_URL` and a unique `NEON_AUTH_COOKIE_SECRET` in `apps/web/.env.local`, and keep `AUTH_JWT_SECRET` identical in the web and API environments. The API reads the repository-root `.env.local`; Next.js reads `apps/web/.env.local`.

- Web: `http://localhost:3000`
- API health: `http://localhost:3001/api/health`

To run the production-shaped application and infrastructure in containers:

```bash
cp .env.example .env
docker compose up --build
```

Before starting Compose, set `AUTH_JWT_SECRET`, `NEON_AUTH_BASE_URL`, and `NEON_AUTH_COOKIE_SECRET` in `.env`. Nginx serves the application at `http://localhost:8080`.

## Build and validation

```bash
pnpm build
pnpm lint
pnpm check:i18n
pnpm check:infra
pnpm security:audit
```

The workspace build compiles the database and pigment packages, the NestJS API, and the Next.js frontend. Database commands are:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

Run the complete browser suite with:

```bash
pnpm test:e2e
```

The E2E runner never loads developer environment files. It creates a PostgreSQL cluster, database, upload directory, and API/web ports that exist only for that test run, applies Drizzle migrations, and removes the temporary resources afterward. The Playwright configuration rejects remote, shared, or manually supplied database targets. The runner requires local PostgreSQL command-line tools (`initdb`, `pg_ctl`, and `createdb`).

## Realtime room isolation

1. HTTP issues a short-lived Socket.IO token for the verified actor.
2. A socket never joins a chat room automatically; the client must emit `room.subscribe`.
3. The gateway verifies membership or an active guest session before joining `room:{roomId}`.
4. Each subscription leaves every previous chat room before joining the requested room.
5. Every event carries `roomId`; the client rejects events that do not match `activeRoomRef`.
6. The Redis adapter routes events to the correct room across multiple API instances.
7. A socket also joins `actor:{id}`. `room.activity` updates unread state for background rooms without leaking `message.created` into the open room.
8. Realtime-token expiry disconnects the socket; the client refreshes the token, subscribes again, and catches up through HTTP.
9. Bounded HTTP reconciliation runs every four seconds while connected and every three seconds while disconnected, so a transient or replayed event cannot leave message, reaction, or read state stale.
10. Each realtime change is written to the transactional outbox with its product transaction. Delivery is at least once, so the client de-duplicates events and reconciles state through HTTP.

`tests/e2e/realtime-isolation.spec.ts` creates guests in separate rooms, attempts an unauthorized subscription, verifies that room A events never arrive on room B's socket, and confirms that actor-channel notifications only signal background-room activity.

PostgreSQL assigns a monotonically increasing `sequence` to every message. Pagination and read state use that sequence instead of timestamps or UUIDs. A UUID `clientRequestId` is the idempotency key that prevents retry duplicates. Guest creation, room creation, messages, reactions, and uploads use atomic PostgreSQL-backed rate limits. A dedicated migration service runs before the API rather than once per replica. The reverse proxy blocks bursts and limits each IP to four concurrent uploads before buffering the body; each owner is also limited to 500 assets, three pending uploads, and 256 MB.

Asset URLs live for 10 minutes by default (`ASSET_URL_TTL`) and are scoped to an actor, room, and asset. The client refreshes expired URLs and requests a fresh URL immediately before **Continue Drawing**, so a short URL lifetime does not break a valid guest session.

## Authentication and retention

Authenticated mode uses Neon Auth in Next.js. The web server reads the signed session and issues a short-lived JWT with `issuer=net-web` and `audience=net-api`; NestJS trusts only JWTs signed with `AUTH_JWT_SECRET`. Both services must use the same secret of at least 32 bytes.

Guests do not need an account and lose access when their session ends. Messages and attached assets a guest already sent remain in the room. The ended guest session, reactions, personal palette, and unattached temporary uploads are removed. `joinRoom`, guest message creation, and guest termination share a PostgreSQL advisory lock per room so concurrent requests cannot produce an inconsistent retention result.

## Current production

- Web: [chat-drawing.vercel.app](https://chat-drawing.vercel.app)
- API: [chat-drawing-api.vercel.app/api/health](https://chat-drawing-api.vercel.app/api/health)
- Database/auth: Neon Postgres + Neon Auth
- Media: private Vercel Blob
- Realtime fan-out: Upstash Redis + Socket.IO Redis adapter

The two Vercel projects point to `apps/web` and `apps/api`. Run Drizzle migrations before deploying the API. The minimum production variables are `DATABASE_URL`, `AUTH_JWT_SECRET`, `REDIS_URL`, `STORAGE_DRIVER=blob`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, and `WEB_ORIGIN`; the web project also needs `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `AUTH_JWT_SECRET`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_REALTIME_URL`.

## Operations and observability

The API returns `X-Request-ID`, emits JSON logs in production, and includes request and trace IDs in 5xx errors. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, it exports traces and metrics over OTLP/HTTP. Hardening details, alert thresholds, object-storage guidance, and local collector instructions live in [docs/OPERATIONS.md](docs/OPERATIONS.md).
