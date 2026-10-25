import { IsUUID } from 'class-validator';

export class RestoreVersionDto {
  @IsUUID()
  versionId!: string;

  /** The user who asked for the restore; recorded as the author of the pre-restore snapshot. */
  @IsUUID()
  userId!: string;
}
