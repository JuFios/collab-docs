import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { COLLAB_CLOSE } from '@collab-docs/shared';
import { ParseUuidPipe } from '@collab-docs/shared/nest';
import { VersionRestoreService } from '../persistence/version-restore.service';
import { DOCUMENT_STORE, type DocumentStore } from '../rooms/document-store';
import { RoomManager } from '../rooms/room-manager';
import { RestoreVersionDto } from './internal.dto';
import { InternalTokenGuard } from './internal-token.guard';

/**
 * Internal API on port 4002 (never published, `Authorization: Bearer <INTERNAL_API_TOKEN>`). Called by the api
 * for the things only the collab service can do correctly because it owns the live documents.
 */
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalController {
  constructor(
    @Inject(RoomManager) private readonly rooms: RoomManager,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(VersionRestoreService) private readonly restoreService: VersionRestoreService,
  ) {}

  @Get('status')
  status(): { rooms: number; connections: number } {
    return { rooms: this.rooms.roomCount(), connections: this.rooms.connectionCount() };
  }

  /** Writes whatever is buffered for the document and answers with the resulting revision. 500 if it cannot. */
  @Post('documents/:id/flush')
  @HttpCode(200)
  async flush(@Param('id', ParseUuidPipe) id: string): Promise<{ revision: number }> {
    await this.store.flush(id);
    return { revision: await this.restoreService.revisionOf(id) };
  }

  /** Replaces the content with a stored version; the pre-restore snapshot is taken first. */
  @Post('documents/:id/restore')
  @HttpCode(200)
  async restore(
    @Param('id', ParseUuidPipe) id: string,
    @Body() body: RestoreVersionDto,
  ): Promise<{ revision: number }> {
    return { revision: await this.restoreService.restore(id, body.versionId, body.userId) };
  }

  /** The document was deleted: final flush, `deleted` to the clients, close with 4410. Idempotent. */
  @Post('documents/:id/close')
  @HttpCode(200)
  async close(@Param('id', ParseUuidPipe) id: string): Promise<{ closed: boolean }> {
    const closed = await this.rooms.closeDocument(id, COLLAB_CLOSE.deleted, 'document deleted', {
      type: 'deleted',
    });
    return { closed };
  }
}
