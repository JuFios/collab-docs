import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type AppConfig } from '@collab-docs/nest';

export interface ObjectInfo {
  size: number;
  contentType: string | undefined;
}

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

const isMissing = (error: unknown): boolean =>
  error instanceof NotFound || error instanceof NoSuchKey;

/**
 * The S3-compatible bucket (MinIO in development). Two clients on purpose: the internal endpoint (the compose
 * network name) serves HEAD/GET/DELETE from the server, while URLs handed to browsers are signed for
 * `S3_PUBLIC_ENDPOINT`, because the signature covers the host.
 */
@Injectable()
export class S3Storage implements OnModuleDestroy {
  private readonly internal: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const credentials = {
      accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
      secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
    };
    const common = { region: 'us-east-1', forcePathStyle: true, credentials } as const;
    this.internal = new S3Client({
      ...common,
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
    });
    this.signer = new S3Client({
      ...common,
      endpoint: config.get('S3_PUBLIC_ENDPOINT', { infer: true }),
    });
    this.bucket = config.get('S3_BUCKET', { infer: true });
  }

  onModuleDestroy(): void {
    this.internal.destroy();
    this.signer.destroy();
  }

  /**
   * Browser-side upload form. The policy pins the key, the content type and an exact length, so the bucket
   * itself refuses anything that differs from what was declared.
   */
  presignPost(options: {
    key: string;
    contentType: string;
    size: number;
    expiresInSeconds: number;
  }): Promise<PresignedPost> {
    return createPresignedPost(this.signer, {
      Bucket: this.bucket,
      Key: options.key,
      Expires: options.expiresInSeconds,
      Fields: { 'Content-Type': options.contentType },
      Conditions: [
        ['content-length-range', options.size, options.size],
        ['eq', '$Content-Type', options.contentType],
        ['eq', '$key', options.key],
      ],
    });
  }

  presignGet(options: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: options.key,
        ResponseContentType: options.contentType,
        // never let the bucket render an upload as a page, whatever it contains
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  /** `null` when the object does not exist. */
  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const response = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: response.ContentLength ?? 0, contentType: response.ContentType };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** The first `length` bytes of the object (a ranged GET). */
  async readHead(key: string, length: number): Promise<Uint8Array> {
    const response = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${length - 1}` }),
    );
    if (!response.Body) return new Uint8Array();
    return response.Body.transformToByteArray();
  }

  /** Deleting an object that is already gone is not an error. */
  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
