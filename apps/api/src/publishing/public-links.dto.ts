import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches, MaxLength, ValidateIf } from 'class-validator';
import {
  EXPIRES_AT_PATTERN,
  PUBLIC_LINK_MODES,
  PUBLIC_LINK_STATUSES,
  PUBLIC_SLUG_MAX_LENGTH,
  PUBLIC_SLUG_PATTERN,
  type EditLinkState,
  type PublicDocument,
  type PublicLinkMode,
  type PublicLinkStatus,
} from '@collab-docs/shared';

export class CreatePublicLinkDto {
  @ApiProperty({
    enum: PUBLIC_LINK_MODES,
    description:
      'VIEW publishes the page at /p/<slug>; EDIT lets anyone with the secret URL edit the document as a guest',
  })
  @IsIn(PUBLIC_LINK_MODES)
  mode!: PublicLinkMode;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'When the link stops working; must lie in the future. Omitted or null: never.',
  })
  @IsOptional()
  @Matches(EXPIRES_AT_PATTERN)
  expiresAt?: string | null;
}

export class UpdatePublicLinkDto {
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description: 'The new expiry; null removes it',
  })
  @ValidateIf((_object, value) => value !== null)
  @Matches(EXPIRES_AT_PATTERN)
  expiresAt!: string | null;
}

export class PublicLinkResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PUBLIC_LINK_MODES }) mode!: PublicLinkMode;
  @ApiProperty({ nullable: true, description: 'VIEW links: the stable address /p/<slug>' })
  slug!: string | null;
  @ApiProperty({ enum: PUBLIC_LINK_STATUSES }) status!: PublicLinkStatus;
  @ApiProperty({ nullable: true }) expiresAt!: string | null;
  @ApiProperty({ nullable: true }) revokedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreatedPublicLinkResponse extends PublicLinkResponse {
  @ApiProperty({
    nullable: true,
    description:
      'EDIT links: the secret that goes into /e/<token>. Shown once, only its hash is stored.',
  })
  token!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'VIEW links: false when the collaboration service could not write its buffer first, so the page may miss the last few seconds of editing',
  })
  flushed!: boolean | null;
}

export class PublicDocumentResponse implements PublicDocument {
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'First 160 characters of the text, for the meta description' })
  description!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Sanitised ProseMirror JSON ({ type: "doc", content: [...] })',
  })
  content!: { type: 'doc'; content: unknown[] };
  @ApiProperty() updatedAt!: string;
}

export class EditLinkStateResponse implements EditLinkState {
  @ApiProperty({ enum: ['EDIT'] }) mode!: 'EDIT';
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) expiresAt!: string | null;
}

export class PublicMediaQueryDto {
  @ApiProperty({ description: 'Slug of the published page that embeds the image' })
  @Matches(PUBLIC_SLUG_PATTERN)
  @MaxLength(PUBLIC_SLUG_MAX_LENGTH)
  slug!: string;
}
