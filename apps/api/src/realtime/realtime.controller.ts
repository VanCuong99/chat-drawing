import { BadRequestException, Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ActorService } from '../auth/actor.service';
import { RateLimitService } from '../security/rate-limit.service';

@Controller('realtime')
export class RealtimeController {
  constructor(private readonly actors: ActorService, private readonly jwt: JwtService, private readonly limits: RateLimitService) {}

  @Post('token')
  @HttpCode(200)
  async token(@Req() request: Request, @Body() body: { roomId?: unknown }) {
    const actor = await this.actors.require(request);
    await this.limits.consume('realtime:token', actor.actorKey, 30, 60 * 1000);
    const roomId = typeof body?.roomId === 'string' ? body.roomId.trim() : '';
    if (!roomId) throw new BadRequestException('Cần chọn cuộc trò chuyện trước khi kết nối realtime.');
    await this.actors.assertRoomAccess(roomId, actor);
    return {
      token: await this.jwt.signAsync({
        sub: actor.id,
        kind: actor.kind,
        actorKey: actor.actorKey,
        displayName: actor.displayName,
        email: actor.email ?? undefined,
        roomId,
      }, { expiresIn: '2m' }),
    };
  }
}
