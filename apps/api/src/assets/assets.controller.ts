import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ActorService } from '../auth/actor.service';
import { AssetsService } from './assets.service';
import { RateLimitService } from '../security/rate-limit.service';

@Controller('assets')
export class AssetsController {
  constructor(private readonly actors: ActorService, private readonly assets: AssetsService, private readonly limits: RateLimitService) {}

  @Post()
  @Header('cache-control', 'no-store')
  @HttpCode(200)
  async upload(
    @Req() request: Request,
    @Query('room') roomId: string,
    @Query('uploadId') uploadId: string | undefined,
    @Body() bytes: Buffer,
  ) {
    const actor = await this.actors.require(request, true);
    await this.limits.consume('asset:upload', actor.actorKey, 30, 5 * 60 * 1000);
    return this.assets.upload(roomId, actor, request.header('content-type')?.split(';')[0] ?? '', Buffer.from(bytes), uploadId);
  }

  @Get(':key')
  async get(@Res() response: Response, @Param('key') key: string, @Query('access') access: string) {
    const { asset, bytes, actor } = await this.assets.readWithAccessToken(key, access);
    response.setHeader('content-type', asset.mimeType);
    response.setHeader('content-length', String(asset.byteSize));
    response.setHeader('cache-control', actor.kind === 'guest' ? 'private, no-store' : 'private, max-age=3600');
    response.send(bytes);
  }

  @Get(':key/access')
  async access(@Req() request: Request, @Param('key') key: string) {
    return this.assets.refreshReadUrl(key, await this.actors.require(request));
  }

  @Delete(':key/pending')
  async discardPending(@Req() request: Request, @Param('key') key: string) {
    return this.assets.discardPending(key, await this.actors.require(request, true));
  }
}
