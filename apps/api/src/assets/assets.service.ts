import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { and, assets, eq, gt, guestSessions, inArray, lt, ne, users, type NetDatabase } from '@net/database';
import { createHash } from 'node:crypto';
import { ActorService } from '../auth/actor.service';
import type { Actor, AssetReadClaims } from '../auth/actor.types';
import { DATABASE } from '../database/database.module';
import { StorageService } from './storage.service';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_SIZE = 8 * 1024 * 1024;
const MAX_OWNER_ASSETS = 500;
const MAX_OWNER_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_ASSETS = 3;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DATABASE) private readonly db: NetDatabase,
    private readonly actors: ActorService,
    private readonly storage: StorageService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async upload(roomId: string, actor: Actor, mimeType: string, bytes: Buffer, uploadId?: string) {
    await this.actors.assertRoomAccess(roomId, actor);
    if (!ALLOWED_TYPES.has(mimeType)) throw new UnsupportedMediaTypeException('Only PNG, JPEG, GIF, and WebP are supported.');
    if (!bytes.length || bytes.length > MAX_SIZE) throw new BadRequestException('Images must be smaller than 8 MB.');
    if (uploadId && !UUID_V4.test(uploadId)) throw new BadRequestException('The upload request ID is invalid.');
    const key = uploadId ?? crypto.randomUUID();
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    const now = Date.now();
    let inserted = false;
    await this.db.transaction(async (tx) => {
      const owner = actor.kind === 'guest'
        ? await tx.select({ id: guestSessions.id }).from(guestSessions).where(and(
          eq(guestSessions.id, actor.id),
          eq(guestSessions.roomId, roomId),
          gt(guestSessions.expiresAt, now),
        )).for('update')
        : await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.id)).for('update');
      if (!owner.length) throw new UnauthorizedException('The session ended before the image was uploaded.');
      const [existing] = await tx.select({ roomId: assets.roomId, ownerKey: assets.ownerKey, mimeType: assets.mimeType, byteSize: assets.byteSize, contentSha256: assets.contentSha256, status: assets.status })
        .from(assets).where(eq(assets.key, key)).limit(1);
      if (existing) {
        if (existing.roomId !== roomId || existing.ownerKey !== actor.actorKey || existing.mimeType !== mimeType || existing.byteSize !== bytes.length || existing.contentSha256 !== contentSha256 || existing.status === 'deleting') {
          throw new BadRequestException('The upload request ID was already used for different content.');
        }
        return;
      }
      const owned = await tx.select({ status: assets.status, byteSize: assets.byteSize }).from(assets)
        .where(and(eq(assets.ownerKey, actor.actorKey), ne(assets.status, 'deleting')));
      if (owned.filter((asset) => asset.status === 'pending').length >= MAX_PENDING_ASSETS) {
        throw new BadRequestException('Too many images are waiting to be sent. Finish the current uploads first.');
      }
      if (owned.length >= MAX_OWNER_ASSETS || owned.reduce((sum, asset) => sum + asset.byteSize, 0) + bytes.length > MAX_OWNER_BYTES) {
        throw new BadRequestException('This session or account has reached its image storage limit.');
      }
      await tx.insert(assets).values({
        key,
        roomId,
        ownerKey: actor.actorKey,
        guestSessionId: actor.kind === 'guest' ? actor.id : null,
        status: 'pending',
        mimeType,
        byteSize: bytes.length,
        contentSha256,
        createdAt: now,
        expiresAt: actor.kind === 'guest' ? actor.expiresAt : null,
      });
      inserted = true;
    });
    try {
      if (!(await this.storage.exists(key))) {
        try {
          await this.storage.put(key, bytes, mimeType);
        } catch (putError) {
          // Two requests with the same upload ID may race. The completed object is
          // the idempotent result as long as it now exists under the same key.
          if (!(await this.storage.exists(key))) throw putError;
        }
      }
      const [ledger] = await this.db.select({ status: assets.status, guestSessionId: assets.guestSessionId }).from(assets).where(eq(assets.key, key)).limit(1);
      if (!ledger || !['pending', 'attached'].includes(ledger.status) || (actor.kind === 'guest' && ledger.guestSessionId !== actor.id)) {
        if (inserted) await this.storage.delete(key);
        throw new UnauthorizedException('The guest session ended while the image was uploading.');
      }
      return { key, size: bytes.length };
    } catch (error) {
      if (inserted) await this.db.delete(assets).where(eq(assets.key, key)).catch(() => undefined);
      throw error;
    }
  }

  async read(key: string, actor: Actor) {
    const [asset] = await this.db.select().from(assets).where(eq(assets.key, key)).limit(1);
    if (!asset) throw new NotFoundException('The image no longer exists.');
    await this.actors.assertRoomAccess(asset.roomId, actor);
    try {
      return { asset, bytes: await this.storage.get(key) };
    } catch {
      throw new NotFoundException('The image no longer exists.');
    }
  }

  async issueReadUrl(key: string, roomId: string, actor: Actor) {
    const token = await this.jwt.signAsync({
      sub: actor.id,
      kind: actor.kind,
      roomId,
      assetKey: key,
      purpose: 'asset-read',
    } satisfies Omit<AssetReadClaims, 'exp'>, {
      audience: 'net-asset',
      expiresIn: this.config.get<string>('ASSET_URL_TTL', '10m') as JwtSignOptions['expiresIn'],
    });
    return `/api/assets/${encodeURIComponent(key)}?access=${encodeURIComponent(token)}`;
  }

  async refreshReadUrl(key: string, actor: Actor) {
    const [asset] = await this.db.select({ roomId: assets.roomId, ownerKey: assets.ownerKey, status: assets.status }).from(assets).where(eq(assets.key, key)).limit(1);
    if (!asset) throw new NotFoundException('The image no longer exists.');
    await this.actors.assertRoomAccess(asset.roomId, actor);
    if (asset.status !== 'attached' && !(asset.status === 'pending' && asset.ownerKey === actor.actorKey)) {
      throw new NotFoundException('The image no longer exists.');
    }
    return { assetUrl: await this.issueReadUrl(key, asset.roomId, actor) };
  }

  async readWithAccessToken(key: string, token: unknown) {
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('The image link is invalid or has expired.');
    let claims: AssetReadClaims;
    try {
      claims = await this.jwt.verifyAsync<AssetReadClaims>(token, { issuer: 'net-api', audience: 'net-asset' });
    } catch {
      throw new UnauthorizedException('The image link is invalid or has expired.');
    }
    if (claims.purpose !== 'asset-read' || claims.assetKey !== key || typeof claims.roomId !== 'string') {
      throw new UnauthorizedException('The image link does not match the requested content.');
    }
    const actor = await this.actors.resolveClaims(claims);
    if (!actor) throw new UnauthorizedException('The image viewing session has expired.');
    const result = await this.read(key, actor);
    if (result.asset.roomId !== claims.roomId) throw new UnauthorizedException('The image link belongs to a different conversation.');
    return { ...result, actor };
  }

  async assertPending(key: string, roomId: string, actor: Actor) {
    const [asset] = await this.db.select().from(assets).where(and(
      eq(assets.key, key),
      eq(assets.roomId, roomId),
      eq(assets.ownerKey, actor.actorKey),
      eq(assets.status, 'pending'),
    )).limit(1);
    if (!asset || !(await this.storage.exists(key))) throw new BadRequestException('The image does not belong to this conversation or has already been sent.');
    return asset;
  }

  async markAttached(key: string, roomId: string, actor: Actor, executor: NetDatabase = this.db) {
    return executor.update(assets).set({ status: 'attached' }).where(and(
      eq(assets.key, key), eq(assets.roomId, roomId), eq(assets.ownerKey, actor.actorKey), eq(assets.status, 'pending'),
    )).returning({ key: assets.key });
  }

  async discardPending(key: string, actor: Actor) {
    const claimed = await this.db.update(assets).set({ status: 'deleting' }).where(and(
      eq(assets.key, key),
      eq(assets.ownerKey, actor.actorKey),
      eq(assets.status, 'pending'),
    )).returning({ key: assets.key });
    if (!claimed.length) return { deleted: false };
    const result = await this.deleteKeys([key]);
    return { deleted: result.deleted.includes(key) };
  }

  async deleteKeys(keys: string[]) {
    if (!keys.length) return { deleted: [] as string[], failed: [] as string[] };
    const uniqueKeys = [...new Set(keys)];
    const removable = await this.db.select({ key: assets.key }).from(assets).where(and(
      inArray(assets.key, uniqueKeys),
      eq(assets.status, 'deleting'),
    ));
    const result = await this.storage.deleteMany(removable.map((asset) => asset.key));
    if (result.deleted.length) {
      await this.db.delete(assets).where(and(inArray(assets.key, result.deleted), eq(assets.status, 'deleting')));
    }
    return result;
  }

  async cleanupOrphans() {
    const stale = await this.db.select({ key: assets.key }).from(assets).where(and(
      eq(assets.status, 'pending'),
      lt(assets.createdAt, Date.now() - 60 * 60 * 1000),
    )).limit(30);
    const claimed = stale.length
      ? await this.db.update(assets).set({ status: 'deleting' }).where(and(
        inArray(assets.key, stale.map((asset) => asset.key)),
        eq(assets.status, 'pending'),
      )).returning({ key: assets.key })
      : [];
    const retry = await this.db.select({ key: assets.key }).from(assets).where(eq(assets.status, 'deleting')).limit(30);
    await this.deleteKeys([...new Set([...claimed, ...retry].map((asset) => asset.key))]);
  }
}
