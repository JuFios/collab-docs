import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/** Every message of the internal API carries the shared secret and, when there is one, the caller's correlation id. */
export class InternalRequestDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsOptional()
  @IsString()
  correlationId?: string;
}

export class DocumentRequestDto extends InternalRequestDto {
  @IsUUID()
  documentId!: string;
}

export class RestoreVersionRequestDto extends DocumentRequestDto {
  @IsUUID()
  versionId!: string;

  /** The user who asked for the restore; recorded as the author of the pre-restore snapshot. */
  @IsUUID()
  userId!: string;
}
