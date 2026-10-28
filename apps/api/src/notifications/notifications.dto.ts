import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  NOTIFICATION_DEFAULT_LIMIT,
  NOTIFICATION_MAX_LIMIT,
  NOTIFICATION_READ_MAX_IDS,
  NOTIFICATION_TYPES,
} from '@collab-docs/shared';
import { decodeNotificationCursor } from './notification-cursor';

/** A cursor ends up in the statement, so only one this module issued is accepted. */
@ValidatorConstraint({ name: 'notificationCursor', async: false })
class NotificationCursorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && decodeNotificationCursor(value) !== null;
  }

  defaultMessage(): string {
    return 'cursor is not valid';
  }
}

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: NOTIFICATION_MAX_LIMIT,
    default: NOTIFICATION_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_MAX_LIMIT)
  limit: number = NOTIFICATION_DEFAULT_LIMIT;

  @ApiPropertyOptional({ description: '`nextCursor` of the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Validate(NotificationCursorConstraint)
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Only notifications that have not been read',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  unread: boolean = false;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exactly one of `ids` (1 to 100 uuids) and `all: true`. */
@ValidatorConstraint({ name: 'markReadTarget', async: false })
class MarkReadTargetConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const { ids, all } = args.object as MarkReadDto;
    if ((ids === undefined) === (all === undefined)) return false;
    if (all !== undefined) return all === true;
    return (
      Array.isArray(ids) &&
      ids.length >= 1 &&
      ids.length <= NOTIFICATION_READ_MAX_IDS &&
      ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))
    );
  }

  defaultMessage(): string {
    return `give either "ids" (1 to ${NOTIFICATION_READ_MAX_IDS} uuids) or "all": true`;
  }
}

export class MarkReadDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: NOTIFICATION_READ_MAX_IDS,
    description:
      'Notifications to mark as read; give this or `all`, not both. Ids that are not the caller’s are ignored.',
  })
  @Validate(MarkReadTargetConstraint)
  ids?: string[];

  @ApiPropertyOptional({
    description: 'Mark every notification of the caller as read',
    enum: [true],
  })
  @IsOptional()
  all?: true;
}

class MentionActorResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

class NotificationPayloadResponse {
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ description: 'The title when the notification was created' })
  documentTitle!: string;
  @ApiProperty({ format: 'uuid' }) threadId!: string;
  @ApiProperty({ format: 'uuid' }) commentId!: string;
  @ApiProperty({ type: MentionActorResponse }) actor!: MentionActorResponse;
  @ApiProperty({ description: 'Start of the comment as plain text (never HTML)' }) excerpt!: string;
}

class NotificationResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: NOTIFICATION_TYPES }) type!: (typeof NOTIFICATION_TYPES)[number];
  @ApiProperty({ type: NotificationPayloadResponse }) payload!: NotificationPayloadResponse;
  @ApiProperty() read!: boolean;
  @ApiProperty() createdAt!: string;
}

export class NotificationPageResponse {
  @ApiProperty({ type: [NotificationResponse] }) items!: NotificationResponse[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class UnreadCountResponse {
  @ApiProperty({ minimum: 0 }) count!: number;
}

export class MarkReadResponse {
  @ApiProperty({ minimum: 0, description: 'Notifications that were unread and are read now' })
  updated!: number;
}
