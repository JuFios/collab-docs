import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { RoomManager } from '../rooms/room-manager';
import { InternalTokenGuard } from './internal-token.guard';

/**
 * Internal API on port 4002 (never published). Document flush and version restore are added with the
 * persistence work; for now it reports what is loaded.
 */
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalController {
  constructor(@Inject(RoomManager) private readonly rooms: RoomManager) {}

  @Get('status')
  status(): { rooms: number; connections: number } {
    return { rooms: this.rooms.roomCount(), connections: this.rooms.connectionCount() };
  }
}
