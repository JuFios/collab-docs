import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import {
  ATTACHMENT_FILENAME_MAX_LENGTH,
  ATTACHMENT_MIME_TYPES,
  type AttachmentMime,
} from '@collab-docs/shared';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PresignAttachmentDto {
  @ApiProperty({
    maxLength: ATTACHMENT_FILENAME_MAX_LENGTH,
    example: 'diagram.png',
    description: 'Original file name; its extension has to belong to `mime`',
  })
  @Transform(trim)
  @IsString()
  @Length(1, ATTACHMENT_FILENAME_MAX_LENGTH)
  filename!: string;

  @ApiProperty({ enum: ATTACHMENT_MIME_TYPES })
  @IsIn(ATTACHMENT_MIME_TYPES)
  mime!: AttachmentMime;

  @ApiProperty({ minimum: 1, description: 'Exact file size in bytes' })
  @IsInt()
  @Min(1)
  size!: number;
}

export class PresignedAttachmentResponse {
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ description: 'Upload target: POST multipart/form-data here' }) url!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Form fields to send before the `file` part (the file must be the last field)',
  })
  fields!: Record<string, string>;
  @ApiProperty() expiresAt!: string;
}

export class AttachmentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ enum: ATTACHMENT_MIME_TYPES }) mime!: AttachmentMime;
  @ApiProperty({ description: 'Bytes' }) size!: number;
  @ApiProperty({ enum: ['PENDING', 'READY'] }) status!: 'PENDING' | 'READY';
  @ApiProperty() createdAt!: string;
}

export class AttachmentUrlResponse {
  @ApiProperty({ description: 'Short-lived download URL' }) url!: string;
  @ApiProperty() expiresAt!: string;
}
