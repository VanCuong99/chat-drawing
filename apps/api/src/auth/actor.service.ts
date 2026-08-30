import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, guestSessions, isNotNull, messages, reactions, roomMembers, users, assets, type NetDatabase } from '@net/database';
import type { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { DATABASE } from '../database/database.module';
import type { Actor, RealtimeClaims } from './actor.types';

const GUEST_TTL_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class ActorService {
  constructor(@Inject(DATABASE) private readonly db: NetDatabase, private readonly jwt: JwtService) {}

  async resolve(request: Request, touch = false): Promise<Actor | null> {
    const authorization = request.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      try {
        const claims = await this.jwt.verifyAsync<RealtimeClaims>(authorization.slice(7), { issuer: 'net-web', audience: 'net-api' });
        if (claims.kind !== 'user' || !claims.email || !claims.displayName) return null;
        await this.upsertUser(claims.sub, claims.email, claims.displayName);
        return { kind: 'user', id: claims.sub, actorKey: `user:${claims.sub}`, displayName: claims.displayName, email: claims.email, expiresAt: null };
      } catch { return null; }
    }
    const guestId = request.header('x-net-guest-session');
    return guestId ? this.resolveGuest(guestId, touch) : null;
  }

  async require(request: Request, touch = false) {
    const actor = await this.resolve(request, touch);
    if (!actor) throw new UnauthorizedException('Your sign-in or guest session has expired.');
    return actor;
  }

  async resolveClaims(claims: RealtimeClaims): Promise<Actor | null> {
    if (claims.kind === 'guest') return this.resolveGuest(claims.sub, false);
    const [user] = await this.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!user) return null;
    return { kind: 'user', id: user.id, actorKey: `user:${user.id}`, displayName: user.displayName, email: user.email, expiresAt: null };
  }

  async assertRoomAccess(roomId: string, actor: Actor) {
    if (actor.kind === 'guest') {
      if (actor.roomId !== roomId) throw new ForbiddenException('This guest session cannot access that room.');
      return;
    }
    const [membership] = await this.db.select({ roomId: roomMembers.roomId }).from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, actor.id))).limit(1);
    if (!membership) throw new ForbiddenException('You have not joined this conversation.');
  }

  guestTtl() { return Date.now() + GUEST_TTL_MS; }

  private async resolveGuest(guestId: string, touch: boolean): Promise<Actor | null> {
    const now = Date.now();
    if (touch) {
      return this.db.transaction(async (tx) => {
        const [guest] = await tx.select().from(guestSessions)
          .where(and(eq(guestSessions.id, guestId), gt(guestSessions.expiresAt, now))).for('update').limit(1);
        if (!guest) return null;
        const expiresAt = now + GUEST_TTL_MS;
        await tx.update(guestSessions).set({ lastSeenAt: now, expiresAt }).where(eq(guestSessions.id, guest.id));
        await tx.update(messages).set({ expiresAt }).where(and(eq(messages.guestSessionId, guest.id), isNotNull(messages.expiresAt)));
        await tx.update(reactions).set({ expiresAt }).where(eq(reactions.actorKey, `guest:${guest.id}`));
        await tx.update(assets).set({ expiresAt }).where(and(eq(assets.guestSessionId, guest.id), isNotNull(assets.expiresAt)));
        return { kind: 'guest', id: guest.id, actorKey: `guest:${guest.id}`, displayName: guest.displayName, email: null, expiresAt, roomId: guest.roomId };
      });
    }
    const [guest] = await this.db.select().from(guestSessions)
      .where(and(eq(guestSessions.id, guestId), gt(guestSessions.expiresAt, now))).limit(1);
    if (!guest) return null;
    return { kind: 'guest', id: guest.id, actorKey: `guest:${guest.id}`, displayName: guest.displayName, email: null, expiresAt: guest.expiresAt, roomId: guest.roomId };
  }

  private async upsertUser(id: string, email: string, displayName: string) {
    const now = Date.now();
    await this.db.insert(users).values({ id, email, displayName, avatarColor: this.colorFor(id), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: users.id, set: { email, displayName, updatedAt: now } });
  }

  private colorFor(value: string) {
    const colors = ['#6f4ee8', '#ef7668', '#3aa694', '#e19a3f', '#4e8fb8', '#9a64cf'];
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }
}
