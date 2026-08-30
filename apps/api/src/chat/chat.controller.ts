import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { ActorService } from '../auth/actor.service';
import { ChatService } from './chat.service';
import { RateLimitService } from '../security/rate-limit.service';
import { configInteger } from '../config/runtime-config';

@Controller()
export class ChatController {
  constructor(
    private readonly actors: ActorService,
    private readonly chat: ChatService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Get('bootstrap')
  async bootstrap(@Req() request: Request) { return this.chat.bootstrap(await this.actors.resolve(request)); }

  @Get('invites/:code')
  async invite(@Req() request: Request, @Param('code') code: string) {
    await this.limits.consume('invite:inspect', this.guestCreateSubject(request), 120, 15 * 60 * 1000);
    return this.chat.inspectInvite(code);
  }

  @Post('guest')
  @HttpCode(200)
  async createGuest(@Req() request: Request, @Body() body: { displayName?: unknown; inviteCode?: unknown }) {
    const limit = configInteger(this.config, 'GUEST_CREATE_LIMIT', 30, { min: 1, max: 10_000 });
    await this.limits.consume('guest:create', this.guestCreateSubject(request), limit, 15 * 60 * 1000);
    return this.chat.createGuest(body.displayName, body.inviteCode);
  }

  @Delete('guest')
  async endGuest(@Req() request: Request) { return this.chat.endGuest(await this.actors.require(request)); }

  @Post('guest/activity')
  @HttpCode(200)
  async guestActivity(@Req() request: Request) {
    const actor = await this.actors.require(request, true);
    return { expiresAt: actor.expiresAt };
  }

  @Get('users')
  async users(@Req() request: Request, @Query('q') query?: string) {
    return this.chat.searchUsers(await this.actors.require(request), query);
  }

  @Post('rooms')
  @HttpCode(200)
  async createRoom(@Req() request: Request, @Body() body: { name?: unknown; allowGuests?: boolean; memberIds?: unknown[] }) {
    const actor = await this.actors.require(request);
    await this.limits.consume('room:create', actor.actorKey, 20, 60 * 60 * 1000);
    return this.chat.createRoom(actor, body);
  }

  @Post('rooms/join')
  @HttpCode(200)
  async joinRoom(@Req() request: Request, @Body() body: { inviteCode?: unknown }) {
    return this.chat.joinRoom(await this.actors.require(request), body.inviteCode);
  }

  @Get('rooms/:id/messages')
  async messages(
    @Req() request: Request,
    @Param('id') roomId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('q') query?: string,
  ) {
    return this.chat.listMessages(roomId, await this.actors.require(request), limit, before, query);
  }

  @Get('rooms/:id/messages/:messageId/lineage')
  async canvasLineage(
    @Req() request: Request,
    @Param('id') roomId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chat.listCanvasLineage(roomId, messageId, await this.actors.require(request));
  }

  @Post('rooms/:id/messages')
  @HttpCode(200)
  async sendMessage(
    @Req() request: Request,
    @Param('id') roomId: string,
    @Body() body: { type?: string; text?: unknown; assetKey?: string; replyToId?: string | null; canvasParentId?: string | null; clientRequestId?: string },
  ) {
    const actor = await this.actors.require(request, true);
    await this.limits.consume('message:send', actor.actorKey, 120, 60 * 1000);
    return this.chat.sendMessage(roomId, actor, body);
  }

  @Patch('rooms/:id/messages')
  async markRead(@Req() request: Request, @Param('id') roomId: string, @Body() body: { messageId?: unknown }) {
    return this.chat.markRead(roomId, await this.actors.require(request, true), body.messageId);
  }

  @Post('messages/:id/reactions')
  @HttpCode(200)
  async reaction(@Req() request: Request, @Param('id') messageId: string, @Body() body: { emoji?: string }) {
    const actor = await this.actors.require(request, true);
    await this.limits.consume('reaction:toggle', actor.actorKey, 180, 60 * 1000);
    return this.chat.toggleReaction(messageId, actor, body.emoji ?? '');
  }

  @Get('health')
  health() {
    return {
      ok: true,
      service: 'net-api',
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.npm_package_version ?? 'local',
    };
  }

  private guestCreateSubject(request: Request) {
    const secret = this.config.get<string>('E2E_RATE_LIMIT_SECRET');
    const marker = request.header('x-net-e2e-rate-key');
    if (secret && marker?.startsWith(`${secret}.`)) {
      const runId = marker.slice(secret.length + 1);
      if (/^[A-Za-z0-9_-]{8,80}$/.test(runId)) return `e2e:${runId}`;
    }
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
