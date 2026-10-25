import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { VERSION_KINDS, VERSION_LABEL_MAX_LENGTH } from '@collab-docs/shared';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateVersionDto {
  @ApiPropertyOptional({ maxLength: VERSION_LABEL_MAX_LENGTH, example: 'Before the review' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(VERSION_LABEL_MAX_LENGTH)
  label?: string;
}

class VersionAuthorResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class VersionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: VERSION_KINDS }) kind!: (typeof VERSION_KINDS)[number];
  @ApiProperty({ nullable: true }) label!: string | null;
  @ApiProperty({ description: 'The document title when the snapshot was taken' }) title!: string;
  @ApiProperty({
    type: VersionAuthorResponse,
    nullable: true,
    description: 'null for automatic snapshots',
  })
  author!: VersionAuthorResponse | null;
  @ApiProperty() createdAt!: string;
}

export class CreatedVersionResponse extends VersionResponse {
  @ApiProperty({
    description:
      'false when the collaboration service could not write its buffer first, so the snapshot may miss the last seconds of editing',
  })
  flushed!: boolean;
}

export class VersionContentResponse extends VersionResponse {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The content as sanitised ProseMirror JSON ({ type: "doc", content: [...] })',
  })
  content!: { type: 'doc'; content: unknown[] };
}

export class RestoredVersionResponse {
  @ApiProperty({ description: 'documents.revision after the restore' }) revision!: number;
}
