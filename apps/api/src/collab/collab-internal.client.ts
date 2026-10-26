import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  AppException,
  type AppConfig,
  CORRELATION_HEADER,
  getCorrelationId,
  getRootLogger,
} from '@collab-docs/nest';

/** Spec §5: the api waits this long for a flush before it carries on with what is stored. */
const FLUSH_TIMEOUT_MS = 2000;
const RESTORE_TIMEOUT_MS = 15_000;

/** Calls the collab service's internal API (port 4002, inside the network only). */
@Injectable()
export class CollabInternalClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Asks collab to write what it has buffered for the document. Never throws: when collab is down or slow the
   * caller proceeds with the stored state and says so (`false`).
   */
  async flush(documentId: string): Promise<boolean> {
    try {
      const response = await this.post(`documents/${documentId}/flush`, {}, FLUSH_TIMEOUT_MS);
      if (response.ok) return true;
      getRootLogger().warn(
        { documentId, status: response.status },
        'collab flush was refused, continuing with the stored state',
      );
    } catch (error) {
      getRootLogger().warn(
        { err: error, documentId },
        'collab flush failed, continuing with the stored state',
      );
    }
    return false;
  }

  /** Replaces the content with a version. Fails loudly: a restore that did not happen must not look like one. */
  async restore(
    documentId: string,
    versionId: string,
    userId: string,
  ): Promise<{ revision: number }> {
    let response: Response;
    try {
      response = await this.post(
        `documents/${documentId}/restore`,
        { versionId, userId },
        RESTORE_TIMEOUT_MS,
      );
    } catch (error) {
      getRootLogger().error({ err: error, documentId }, 'collab restore request failed');
      throw new AppException('SERVICE_UNAVAILABLE', 'The collaboration service is not available');
    }
    if (response.status === 404) throw new AppException('NOT_FOUND', 'Version not found');
    if (!response.ok) {
      getRootLogger().error({ documentId, status: response.status }, 'collab restore failed');
      throw new AppException('SERVICE_UNAVAILABLE', 'The version could not be restored');
    }
    return (await response.json()) as { revision: number };
  }

  private post(path: string, body: object, timeoutMs: number): Promise<Response> {
    const correlationId = getCorrelationId();
    return fetch(`${this.config.COLLAB_INTERNAL_URL.replace(/\/+$/, '')}/internal/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.INTERNAL_API_TOKEN}`,
        ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}
