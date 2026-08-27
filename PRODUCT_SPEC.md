# Nét — Product specification

## Product goal

Nét is a responsive, installable web messenger where people can express an idea with text, an uploaded image, or an editable drawing. A drawing is sent as a message and can be remixed into a new version without overwriting its history.

## Users and retention

- Authenticated users sign in with ChatGPT. Their rooms, messages, reactions, read state, images, and drawing versions are stored permanently.
- Guests join with a display name through an invite link or start a temporary room. A guest session expires after two hours of inactivity or immediately when the guest chooses **End session**.
- When a guest session ends, the guest loses access but sent messages and attached assets remain in the room. Guest reactions, palette data, and unattached temporary uploads are removed.
- The drawing studio mixes 2–12 display colors simultaneously with a Kubelka–Munk-based sRGB/D65 approximation. Each component has an integer model-concentration parts value from 1–100; the UI shows normalized percentages and preserves duplicate component provenance. It must be described as an approximation because real results depend on measured pigment K/S spectra, binders, substrate, and lighting.
- A person can name and save up to 24 mixed-color formulas, reuse the result, reload the full component formula for further mixing, and delete it. An authenticated user's palette is persistent; a guest palette belongs to the guest session and is cascade-deleted when that session ends.

## Core workflows

1. An anonymous visitor can sign in or continue as a guest.
2. An authenticated user can create a room, copy its invite link, send text, upload an image, or draw on a canvas.
3. A guest can join an invite-enabled room, send temporary content, react, reply, and see new messages during the session.
4. A recipient can reply to a message, add or remove a reaction, and see whether an outgoing message has been read.
5. A recipient can open a drawing, modify it, and send it as the next immutable version.
6. The UI supports desktop, mobile navigation, keyboard/touch input, and PWA installation.

## Validation and errors

- Message text: 1–2,000 characters after trimming.
- Room name and guest name: 2–60 characters.
- Images: PNG, JPEG, GIF, or WebP, maximum 8 MB.
- Invalid/expired invite links show a recoverable Vietnamese error.
- An expired guest session returns to onboarding and does not expose previous guest content.
- Every server write checks authenticated membership or a valid guest session.

## Runtime architecture

- Vinext renders the web client; it contains no business API routes.
- NestJS owns HTTP APIs, guest lifecycle, authorization, asset metadata and Socket.IO.
- PostgreSQL is accessed exclusively through Drizzle ORM repositories/services and generated migrations.
- Socket connections receive short-lived tokens, may join only authorized `room:{id}` channels, and every event carries a `roomId` checked again by the client.
- Redis is the Socket.IO adapter in multi-instance production deployments; disconnected clients fall back to bounded polling.
- Room-background activity travels through actor-scoped channels without leaking the room's message event; reconnect always performs HTTP catch-up.
- A PostgreSQL identity sequence is the canonical message order. Read state advances to the exact rendered sequence and client request UUIDs make message retries idempotent.
- Realtime notifications use a transactional PostgreSQL outbox and at-least-once delivery; signed asset URLs are actor/room scoped and distributed write limits are stored atomically in PostgreSQL.
- Multi-host production stores bytes in private S3-compatible object storage while PostgreSQL remains the metadata/authorization source.

## Acceptance scenarios

| Priority | Scenario | Expected result |
| --- | --- | --- |
| High | Authenticated user reloads | Permanent rooms and messages are restored |
| High | Guest ends session | Guest messages, reactions, and assets are removed |
| High | Send text/image/drawing | Message appears and is visible to other room participants |
| High | Remix drawing | New version links to the previous drawing and history remains intact |
| High | Reply/react/read | UI and server state remain consistent after reload |
| High | WebSocket room isolation | A client receives events only for the currently authorized room |
| Medium | Invalid invite or expired session | Clear error and safe return to onboarding |
| Medium | Mobile/PWA | Main flows work at narrow viewport and the app is installable |
