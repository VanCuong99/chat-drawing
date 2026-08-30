import { MAX_PIGMENT_COMPONENTS, MIN_PIGMENT_COMPONENTS, PIGMENT_MODEL, mixPigmentHex, type PigmentComponent } from '@net/pigment';
import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, asc, eq, guestSessions, paletteColors, users, type NetDatabase } from '@net/database';
import type { Actor } from '../auth/actor.types';
import { DATABASE } from '../database/database.module';

const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const MAX_PALETTE_COLORS = 24;

@Injectable()
export class PaletteService {
  constructor(@Inject(DATABASE) private readonly db: NetDatabase) {}

  async list(actor: Actor) {
    const rows = await this.db.select().from(paletteColors)
      .where(this.actorScope(actor))
      .orderBy(asc(paletteColors.createdAt), asc(paletteColors.id));
    return { colors: rows.map((row) => this.toView(row)) };
  }

  async create(actor: Actor, body: { name?: unknown; components?: unknown; sourceA?: unknown; sourceB?: unknown; ratio?: unknown }) {
    const components = body.components === undefined ? this.requireLegacyComponents(body) : this.requireComponents(body.components);
    const inputName = typeof body.name === 'string' ? body.name.trim() : '';
    if (inputName.length > 40) throw new BadRequestException('Color names cannot exceed 40 characters.');

    return this.db.transaction(async (tx) => {
      const owner = actor.kind === 'user'
        ? await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.id)).for('update')
        : await tx.select({ id: guestSessions.id }).from(guestSessions).where(eq(guestSessions.id, actor.id)).for('update');
      if (!owner.length) throw new UnauthorizedException('Your sign-in or guest session has expired.');

      const existing = await tx.select({ id: paletteColors.id }).from(paletteColors)
        .where(this.actorScope(actor)).limit(MAX_PALETTE_COLORS);
      if (existing.length >= MAX_PALETTE_COLORS) throw new BadRequestException(`A palette can store up to ${MAX_PALETTE_COLORS} colors.`);

      const [created] = await tx.insert(paletteColors).values({
        userId: actor.kind === 'user' ? actor.id : null,
        guestSessionId: actor.kind === 'guest' ? actor.id : null,
        name: inputName || `Mixed Color ${existing.length + 1}`,
        color: mixPigmentHex(components),
        sourceA: components[0].color,
        sourceB: components[1].color,
        ratio: Math.max(1, Math.min(99, Math.round(components[1].weight / (components[0].weight + components[1].weight) * 100))),
        components,
        modelId: PIGMENT_MODEL.id,
        modelVersion: PIGMENT_MODEL.version,
        colorSpace: PIGMENT_MODEL.colorSpace,
        illuminant: PIGMENT_MODEL.illuminant,
        createdAt: Date.now(),
      }).returning();
      return { color: this.toView(created) };
    });
  }

  async remove(actor: Actor, id: string) {
    const [removed] = await this.db.delete(paletteColors)
      .where(and(eq(paletteColors.id, id), this.actorScope(actor)))
      .returning({ id: paletteColors.id });
    if (!removed) throw new NotFoundException('This color is not in your palette.');
    return { ok: true };
  }

  private actorScope(actor: Actor) {
    return actor.kind === 'user' ? eq(paletteColors.userId, actor.id) : eq(paletteColors.guestSessionId, actor.id);
  }

  private requireColor(value: unknown, label: string) {
    const color = typeof value === 'string' ? value.toUpperCase() : '';
    if (!HEX_COLOR.test(color)) throw new BadRequestException(`${label} must be a 6-digit HEX color.`);
    return color;
  }

  private requireComponents(value: unknown): PigmentComponent[] {
    if (!Array.isArray(value) || value.length < MIN_PIGMENT_COMPONENTS || value.length > MAX_PIGMENT_COMPONENTS) {
      throw new BadRequestException(`A formula needs ${MIN_PIGMENT_COMPONENTS} to ${MAX_PIGMENT_COMPONENTS} component colors.`);
    }
    return value.map((item, index) => {
      if (!item || typeof item !== 'object') throw new BadRequestException(`Color ${index + 1} is invalid.`);
      const component = item as { color?: unknown; weight?: unknown };
      const weight = Number(component.weight);
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
        throw new BadRequestException(`Parts for color ${index + 1} must be between 1 and 100.`);
      }
      return { color: this.requireColor(component.color, `Color ${index + 1}`), weight };
    });
  }

  private requireLegacyComponents(body: { sourceA?: unknown; sourceB?: unknown; ratio?: unknown }): PigmentComponent[] {
    const ratio = Number(body.ratio);
    if (!Number.isInteger(ratio) || ratio < 1 || ratio > 99) {
      throw new BadRequestException('The legacy mix ratio must be between 1 and 99.');
    }
    return [
      { color: this.requireColor(body.sourceA, 'Color A'), weight: 100 - ratio },
      { color: this.requireColor(body.sourceB, 'Color B'), weight: ratio },
    ];
  }

  private toView(row: typeof paletteColors.$inferSelect) {
    const components = row.components.length >= MIN_PIGMENT_COMPONENTS
      ? row.components
      : [{ color: row.sourceA, weight: 100 - row.ratio }, { color: row.sourceB, weight: row.ratio }];
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      sourceA: row.sourceA,
      sourceB: row.sourceB,
      ratio: row.ratio,
      components,
      model: { id: row.modelId, version: row.modelVersion, colorSpace: row.colorSpace, illuminant: row.illuminant },
      createdAt: row.createdAt,
    };
  }
}
