import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const roomKind = pgEnum('room_kind', ['direct', 'group', 'guest']);
export const roomRole = pgEnum('room_role', ['owner', 'member']);
export const messageType = pgEnum('message_type', ['system', 'text', 'image', 'canvas']);
export const assetStatus = pgEnum('asset_status', ['pending', 'attached', 'deleting']);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  avatarColor: text('avatar_color').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => [uniqueIndex('users_email_unique').on(table.email)]);

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStartedAt: bigint('window_started_at', { mode: 'number' }).notNull(),
  count: integer('count').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => [index('rate_limits_updated_idx').on(table.updatedAt)]);

export const rooms = pgTable('rooms', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  kind: roomKind('kind').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  inviteCode: text('invite_code').notNull(),
  allowGuests: boolean('allow_guests').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => [
  uniqueIndex('rooms_invite_code_unique').on(table.inviteCode),
  index('rooms_created_by_idx').on(table.createdBy),
]);

export const roomMembers = pgTable('room_members', {
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: roomRole('role').notNull(),
  joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
  lastReadSequence: bigint('last_read_sequence', { mode: 'number' }).notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.roomId, table.userId] }),
  index('room_members_user_room_idx').on(table.userId, table.roomId),
]);

export const guestSessions = pgTable('guest_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
  lastReadSequence: bigint('last_read_sequence', { mode: 'number' }).notNull().default(0),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('guest_sessions_room_expiry_idx').on(table.roomId, table.expiresAt),
  index('guest_sessions_expiry_idx').on(table.expiresAt),
]);

export type PaletteComponentData = { color: string; weight: number };

export const paletteColors = pgTable('palette_colors', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  guestSessionId: uuid('guest_session_id').references(() => guestSessions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  sourceA: text('source_a').notNull(),
  sourceB: text('source_b').notNull(),
  ratio: integer('ratio').notNull(),
  components: jsonb('components').$type<PaletteComponentData[]>().notNull().default([]),
  modelId: text('model_id').notNull().default('spectral-kubelka-munk-rgb'),
  modelVersion: integer('model_version').notNull().default(1),
  colorSpace: text('color_space').notNull().default('sRGB'),
  illuminant: text('illuminant').notNull().default('D65'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('palette_colors_user_created_idx').on(table.userId, table.createdAt),
  index('palette_colors_guest_created_idx').on(table.guestSessionId, table.createdAt),
  check('palette_colors_single_owner_check', sql`(${table.userId} is not null) <> (${table.guestSessionId} is not null)`),
  check('palette_colors_ratio_check', sql`${table.ratio} between 1 and 99`),
  check('palette_colors_components_count_check', sql`jsonb_array_length(${table.components}) = 0 or jsonb_array_length(${table.components}) between 2 and 12`),
]);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  senderId: text('sender_id').references(() => users.id, { onDelete: 'set null' }),
  guestSessionId: uuid('guest_session_id').references(() => guestSessions.id, { onDelete: 'cascade' }),
  senderName: text('sender_name').notNull(),
  type: messageType('type').notNull(),
  body: text('body'),
  assetKey: uuid('asset_key').references(() => assets.key, { onDelete: 'set null' }),
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  canvasParentId: uuid('canvas_parent_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  canvasVersion: integer('canvas_version'),
  clientRequestId: uuid('client_request_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  editedAt: bigint('edited_at', { mode: 'number' }),
  expiresAt: bigint('expires_at', { mode: 'number' }),
}, (table) => [
  uniqueIndex('messages_room_sequence_unique').on(table.roomId, table.sequence),
  index('messages_guest_expiry_idx').on(table.guestSessionId, table.expiresAt),
  index('messages_reply_to_idx').on(table.replyToId),
  index('messages_canvas_parent_idx').on(table.canvasParentId),
  uniqueIndex('messages_asset_key_unique').on(table.assetKey),
  uniqueIndex('messages_client_request_unique').on(table.clientRequestId),
]);

export type RealtimeOutboxPayload = Record<string, unknown>;

export const realtimeOutbox = pgTable('realtime_outbox', {
  id: uuid('id').defaultRandom().primaryKey(),
  roomId: uuid('room_id').notNull(),
  event: text('event').notNull(),
  payload: jsonb('payload').$type<RealtimeOutboxPayload>().notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  availableAt: bigint('available_at', { mode: 'number' }).notNull(),
  lockedUntil: bigint('locked_until', { mode: 'number' }),
  workerId: uuid('worker_id'),
  publishedAt: bigint('published_at', { mode: 'number' }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
}, (table) => [
  index('realtime_outbox_delivery_idx').on(table.publishedAt, table.availableAt, table.lockedUntil),
  index('realtime_outbox_created_idx').on(table.createdAt),
]);

export const reactions = pgTable('reactions', {
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  actorKey: text('actor_key').notNull(),
  emoji: text('emoji').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.actorKey, table.emoji] }),
  index('reactions_message_idx').on(table.messageId),
  index('reactions_expiry_idx').on(table.expiresAt),
]);

export const assets = pgTable('assets', {
  key: uuid('key').defaultRandom().primaryKey(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  ownerKey: text('owner_key').notNull(),
  guestSessionId: uuid('guest_session_id').references(() => guestSessions.id, { onDelete: 'set null' }),
  status: assetStatus('status').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
}, (table) => [
  index('assets_room_idx').on(table.roomId),
  index('assets_owner_status_idx').on(table.ownerKey, table.status),
  index('assets_guest_status_idx').on(table.guestSessionId, table.status),
  index('assets_status_created_idx').on(table.status, table.createdAt),
]);

export type DatabaseSchema = typeof import('./schema');
