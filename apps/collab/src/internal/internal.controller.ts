import { Controller, Inject, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { COLLAB_CLOSE, COLLAB_INTERNAL } from '@collab-docs/shared';
import { runWithCorrelationId } from '@collab-docs/nest';
import { VersionRestoreService } from '../persistence/version-restore.service';
import { DOCUMENT_STORE, type DocumentStore } from '../rooms/document-store';
import { RoomManager } from '../rooms/room-manager';
import { DocumentRequestDto, InternalRequestDto, RestoreVersionRequestDto } from './internal.dto';
import { InternalTokenGuard } from './internal-token.guard';

/** Runs the handler under the caller's correlation id, so its log lines carry the id of the request that caused it. */
const under = <T>(request: InternalRequestDto, work: () => Promise<T>): Promise<T> =>
  request.correlationId ? runWithCorrelationId(request.correlationId, work) : work();

/**
 * Internal API on port 4002 (TCP, never published; every message carries `INTERNAL_API_TOKEN`). Called by the api
 * for the things only the collab service can do correctly because it owns the live documents. Failures reach the
 * caller as the error body of `AllExceptionsFilter` (`statusCode`, `code`, `message`).
 */
@Controller()
@UseGuards(InternalTokenGuard)
export class InternalController {
  constructor(
    private readonly rooms: RoomManager,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    private readonly restoreService: VersionRestoreService,
  ) {}

  @MessagePattern(COLLAB_INTERNAL.status)
  status(@Payload() request: InternalRequestDto): Promise<{ rooms: number; connections: number }> {
    return under(request, () =>
      Promise.resolve({
        rooms: this.rooms.roomCount(),
        connections: this.rooms.connectionCount(),
      }),
    );
  }

  /** Writes whatever is buffered for the document and answers with the resulting revision. Fails if it cannot. */
  @MessagePattern(COLLAB_INTERNAL.flush)
  flush(@Payload() request: DocumentRequestDto): Promise<{ revision: number }> {
    return under(request, async () => {
      await this.store.flush(request.documentId);
      return { revision: await this.restoreService.revisionOf(request.documentId) };
    });
  }

  /** Replaces the content with a stored version; the pre-restore snapshot is taken first. */
  @MessagePattern(COLLAB_INTERNAL.restore)
  restore(@Payload() request: RestoreVersionRequestDto): Promise<{ revision: number }> {
    return under(request, async () => ({
      revision: await this.restoreService.restore(
        request.documentId,
        request.versionId,
        request.userId,
      ),
    }));
  }

  /** The document was deleted: final flush, `deleted` to the clients, close with 4410. Idempotent. */
  @MessagePattern(COLLAB_INTERNAL.close)
  close(@Payload() request: DocumentRequestDto): Promise<{ closed: boolean }> {
    return under(request, async () => ({
      closed: await this.rooms.closeDocument(
        request.documentId,
        COLLAB_CLOSE.deleted,
        'document deleted',
        { type: 'deleted' },
      ),
    }));
  }
}
