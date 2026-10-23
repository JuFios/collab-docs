import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const VISIBILITIES = ['WORKSPACE', 'RESTRICTED'] as const;
const SHARE_ROLES = ['VIEWER', 'EDITOR'] as const;
const ACCESS_LEVELS = ['VIEW', 'COMMENT', 'EDIT', 'MANAGE'] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateDocumentDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Omit to create at the workspace root' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ maxLength: 200, example: 'Meeting notes' })
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  title!: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 32, description: 'Emoji; null clears it' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  icon?: string | null;

  @ApiPropertyOptional({ enum: VISIBILITIES })
  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: (typeof VISIBILITIES)[number];
}

export class MoveDocumentDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'New parent; null moves to the root',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parentId!: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Place the document right before this sibling',
  })
  @IsOptional()
  @IsUUID()
  beforeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Place the document right after this sibling',
  })
  @IsOptional()
  @IsUUID()
  afterId?: string;
}

export class CreateShareDto {
  @ApiProperty({ example: 'grace@example.com', description: 'Must belong to a registered user' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ enum: SHARE_ROLES })
  @IsEnum(SHARE_ROLES)
  role!: (typeof SHARE_ROLES)[number];
}

export class UpdateShareDto {
  @ApiProperty({ enum: SHARE_ROLES })
  @IsEnum(SHARE_ROLES)
  role!: (typeof SHARE_ROLES)[number];
}

export class DocumentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'null when the parent is hidden from the caller',
  })
  parentId!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) icon!: string | null;
  @ApiProperty() position!: string;
  @ApiProperty({ enum: VISIBILITIES }) visibility!: (typeof VISIBILITIES)[number];
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ACCESS_LEVELS }) myAccess!: (typeof ACCESS_LEVELS)[number];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TreeNodeResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) parentId!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) icon!: string | null;
  @ApiProperty() position!: string;
  @ApiProperty({ enum: VISIBILITIES }) visibility!: (typeof VISIBILITIES)[number];
  @ApiProperty({ enum: ACCESS_LEVELS }) myAccess!: (typeof ACCESS_LEVELS)[number];
}

export const RECENT_DEFAULT_LIMIT = 8;
export const RECENT_MAX_LIMIT = 20;

export class RecentDocumentsQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: RECENT_MAX_LIMIT,
    default: RECENT_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RECENT_MAX_LIMIT)
  limit: number = RECENT_DEFAULT_LIMIT;
}

export class RecentDocumentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) icon!: string | null;
  @ApiProperty({ enum: ACCESS_LEVELS }) myAccess!: (typeof ACCESS_LEVELS)[number];
  @ApiProperty() updatedAt!: string;
}

export class MovedDocumentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) parentId!: string | null;
  @ApiProperty() position!: string;
}

export class TrashItemResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) icon!: string | null;
  @ApiProperty() deletedAt!: string;
  @ApiProperty({ description: 'Live documents restored together with it' }) documentCount!: number;
  @ApiProperty({ description: 'Whether the caller may restore it' }) canRestore!: boolean;
}

export class ShareResponse {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SHARE_ROLES }) role!: (typeof SHARE_ROLES)[number];
}

export class SharedDocumentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) icon!: string | null;
  @ApiProperty({ enum: SHARE_ROLES }) role!: (typeof SHARE_ROLES)[number];
}
