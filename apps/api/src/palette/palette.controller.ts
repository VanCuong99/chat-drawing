import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ActorService } from '../auth/actor.service';
import { PaletteService } from './palette.service';

@Controller('palette')
export class PaletteController {
  constructor(private readonly actors: ActorService, private readonly palette: PaletteService) {}

  @Get()
  async list(@Req() request: Request) {
    return this.palette.list(await this.actors.require(request));
  }

  @Post()
  @HttpCode(200)
  async create(
    @Req() request: Request,
    @Body() body: { name?: unknown; components?: unknown; sourceA?: unknown; sourceB?: unknown; ratio?: unknown },
  ) {
    return this.palette.create(await this.actors.require(request, true), body);
  }

  @Delete(':id')
  async remove(@Req() request: Request, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.palette.remove(await this.actors.require(request, true), id);
  }
}
