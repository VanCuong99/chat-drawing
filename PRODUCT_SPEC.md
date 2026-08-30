# Nét — Product specification

## Product goal

Nét is a responsive, installable web messenger where people can express an idea with text, an uploaded image, or an editable drawing. A drawing is sent as a message and can be remixed into a new version without overwriting its history.

## Users and retention

- Authenticated users sign in through Neon Auth. Their rooms, messages, reactions, read state, images, drawing versions, and personal palette are stored permanently.
- Guests join with a display name through an invite link or start a temporary room. A guest session expires after two hours of inactivity or immediately when the guest chooses **End session**.
- When a guest session ends, the guest loses access but sent messages and attached assets remain in the room. Guest reactions, palette data, and unattached temporary uploads are removed.
- The drawing studio mixes 2–12 display colors simultaneously with a Kubelka–Munk-based sRGB/D65 approximation. Each component has an integer model-concentration parts value from 1–100; the UI shows normalized percentages and preserves duplicate component provenance. It must be described as an approximation because real results depend on measured pigment K/S spectra, binders, substrate, and lighting.
- A person can name and save up to 24 mixed-color formulas, reuse the result, reload the full component formula for further mixing, and delete it. An authenticated user's palette is persistent; a guest palette belongs to the guest session and is cascade-deleted when that session ends.

## Core workflows

1. An anonymous visitor can make a first mark on the landing canvas before choosing a display name or signing in.
2. An invite preview identifies the room, inviter, participant count, participant display names/avatars, and recent activity type without exposing message bodies, email addresses, or private assets.
3. An authenticated user chooses people in one picker: one selected person opens a direct message; two or more creates a group and then reveals group options.
4. In a room, **Draw** is the primary composer action while Text and Photo remain immediately available. Every drawing message exposes **Continue this drawing** as its primary follow-up.
5. A guest can join an invite-enabled room, send content, react, reply, and see new messages during the session.
6. After a guest contributes a drawing, the UI offers account creation to keep access to the room and drawing history.
7. A recipient can reply to a message, add or remove a reaction, and see whether an outgoing message has been read.
8. A recipient can open the complete lineage of a drawing independently of paginated chat history, compare any two versions, select any historical or branched version, and continue it as a new immutable child.
9. On mobile, Studio prioritizes the canvas, keeps Pencil, Eraser, Color, Undo, and More in the bottom dock, and opens tool settings in a contextual sheet.
10. Studio uses one finger or stylus for marks and reserves two-finger gestures for focal-point pinch zoom and canvas pan without committing an accidental mark.
11. The UI supports desktop and mobile navigation, keyboard/touch input, and PWA installation.

## Validation and errors

- Message text: 1–2,000 characters after trimming.
- Room name and guest name: 2–60 characters.
- Images: PNG, JPEG, GIF, or WebP, maximum 8 MB.
- Invalid or expired invite links show a recoverable error in the selected language.
- An expired guest session returns to onboarding and does not expose previous guest content.
- Every server write checks authenticated membership or a valid guest session.

## Runtime architecture

- Next.js App Router renders the web client; it contains no product business API routes.
- NestJS owns HTTP APIs, guest lifecycle, authorization, asset metadata and Socket.IO.
- PostgreSQL is accessed exclusively through Drizzle ORM repositories/services and generated migrations.
- Socket connections receive short-lived tokens, may join only authorized `room:{id}` channels, and every event carries a `roomId` checked again by the client.
- Redis is the Socket.IO adapter in multi-instance production deployments; clients also run bounded HTTP reconciliation to recover from transient or replayed events.
- Room-background activity travels through actor-scoped channels without leaking the room's message event; reconnect always performs HTTP catch-up.
- A PostgreSQL identity sequence is the canonical message order. Read state advances to the exact rendered sequence and client request UUIDs make message retries idempotent.
- Realtime notifications use a transactional PostgreSQL outbox and at-least-once delivery; signed asset URLs are actor/room scoped and distributed write limits are stored atomically in PostgreSQL.
- Multi-host production stores bytes in private Vercel Blob while PostgreSQL remains the metadata and authorization source.

## Acceptance scenarios

| Priority | Scenario | Expected result |
| --- | --- | --- |
| High | Authenticated user reloads | Permanent rooms and messages are restored |
| High | Guest ends session | Guest access, reactions, palette data, and unattached uploads are removed; already-sent messages and attached assets remain |
| High | Send text/image/drawing | Message appears and is visible to other room participants |
| High | Remix drawing | New version links to the previous drawing and history remains intact |
| High | Drawing lineage and compare | Authorized room members can see the full connected version family, compare two selected versions, and continue from either; people outside the room receive no lineage or asset URL |
| High | Reply/react/read | UI and server state remain consistent after reload |
| High | WebSocket room isolation | A client receives events only for the currently authorized room |
| High | Open invite before joining | Social context is visible, while message content and participant emails remain private |
| High | First-time landing contribution | A visitor can draw before entering a name, then continue that mark in Studio |
| High | Mobile Studio | Canvas occupies most of the workspace; five primary dock controls and contextual settings remain reachable with 44 px touch targets |
| High | Mobile canvas gestures | Pinch zoom follows the midpoint of two fingers, two-finger movement pans the enlarged paper, and neither gesture creates or commits a drawing action |
| Medium | Invalid invite or expired session | Clear error and safe return to onboarding |
| Medium | Mobile/PWA | Main flows work at narrow viewport and the app is installable |
