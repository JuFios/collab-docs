import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { COLLAB_INTERNAL } from '@collab-docs/shared';
import {
  AppException,
  type AppConfig,
  getCorrelationId,
  InjectPinoLogger,
  PinoLogger,
} from '@collab-docs/nest';

/** Spec §5: the api waits this long for a flush before it carries on with what is stored. */
const FLUSH_TIMEOUT_MS = 2000;
const RESTORE_TIMEOUT_MS = 15_000;

/** What the collab service answers with when it refused or failed a request (the error body of its filter). */
const refusal = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : undefined;

/** Calls the collab service's internal API (TCP, port 4002, inside the network only). */
@Injectable()
export class CollabInternalClient implements OnModuleDestroy {
  private connection: { url: string; client: ClientProxy } | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(CollabInternalClient.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Asks collab to write what it has buffered for the document. Never throws: when collab is down or slow the
   * caller proceeds with the stored state and says so (`false`).
   */
  async flush(documentId: string): Promise<boolean> {
    try {
      await this.send(COLLAB_INTERNAL.flush, { documentId }, FLUSH_TIMEOUT_MS);
      return true;
    } catch (error) {
      const status = refusal(error);
      this.logger.warn(
        { err: error, documentId, status },
        status
          ? 'collab flush was refused, continuing with the stored state'
          : 'collab flush failed, continuing with the stored state',
      );
      return false;
    }
  }

  /** Replaces the content with a version. Fails loudly: a restore that did not happen must not look like one. */
  async restore(
    documentId: string,
    versionId: string,
    userId: string,
  ): Promise<{ revision: number }> {
    try {
      return await this.send<{ revision: number }>(
        COLLAB_INTERNAL.restore,
        { documentId, versionId, userId },
        RESTORE_TIMEOUT_MS,
      );
    } catch (error) {
      const status = refusal(error);
      if (status === 404) throw new AppException('NOT_FOUND', 'Version not found');
      if (status) {
        this.logger.error({ documentId, status }, 'collab restore failed');
        throw new AppException('SERVICE_UNAVAILABLE', 'The version could not be restored');
      }
      this.logger.error({ err: error, documentId }, 'collab restore request failed');
      throw new AppException('SERVICE_UNAVAILABLE', 'The collaboration service is not available');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.connection?.client.close();
    this.connection = null;
  }

  private send<T = unknown>(
    pattern: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    return firstValueFrom(
      this.client()
        .send<T>(pattern, {
          token: this.config.get('INTERNAL_API_TOKEN', { infer: true }),
          correlationId: getCorrelationId(),
          ...payload,
        })
        .pipe(timeout(timeoutMs)),
    );
  }

  /** One connection per configured address; the address is read on every call because tests point it elsewhere. */
  private client(): ClientProxy {
    const url = this.config.get('COLLAB_INTERNAL_URL', { infer: true });
    if (this.connection?.url !== url) {
      this.connection?.client.close();
      const { hostname, port } = new URL(url);
      this.connection = {
        url,
        client: ClientProxyFactory.create({
          transport: Transport.TCP,
          options: { host: hostname, port: Number(port) },
        }),
      };
    }
    return this.connection.client;
  }
}
