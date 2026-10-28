import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  BLOCK_ID_FORMAT,
  COMMENT_BODY_MAX_LENGTH,
  MENTIONABLE_QUERY_MAX_LENGTH,
  THREAD_STATUSES,
  type ThreadStatus,
} from '@collab-docs/shared';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

const BODY_DESCRIPTION =
  'Plain text, at most 4000 characters, shown as text and never as HTML. `@[<user id>]` mentions a user who can view ' +
  'the document; a mention of anyone else is removed and reported in `warnings`.';

export class CreateCommentDto {
  @ApiProperty({ minLength: 1, maxLength: COMMENT_BODY_MAX_LENGTH, description: BODY_DESCRIPTION })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body!: string;
}

export class UpdateCommentDto extends CreateCommentDto {}

export class CreateThreadDto extends CreateCommentDto {
  @ApiProperty({
    maxLength: 64,
    pattern: BLOCK_ID_FORMAT.source,
    description:
      'Id of the block the thread is about (the `id` attribute of the block in the document). Not checked against ' +
      'the stored content, which can be a few seconds behind the editor.',
  })
  @IsString()
  @Matches(BLOCK_ID_FORMAT)
  blockId!: string;
}

export class ListThreadsQueryDto {
  @ApiPropertyOptional({ enum: THREAD_STATUSES, default: 'all' })
  @IsOptional()
  @IsIn(THREAD_STATUSES)
  status: ThreadStatus = 'all';
}

export class MentionableQueryDto {
  @ApiPropertyOptional({
    maxLength: MENTIONABLE_QUERY_MAX_LENGTH,
    description: 'Start of a name or an email address; empty lists the first users by name',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MENTIONABLE_QUERY_MAX_LENGTH)
  q: string = '';
}

class PersonResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

class CommentMentionResponse {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
}

export class CommentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: PersonResponse }) author!: PersonResponse;
  @ApiProperty({
    description: 'Empty when the comment was deleted. Plain text with `@[user id]` tokens.',
  })
  body!: string;
  @ApiProperty() deleted!: boolean;
  @ApiProperty({
    type: [CommentMentionResponse],
    description: 'The users the body mentions, with names',
  })
  mentions!: CommentMentionResponse[];
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) editedAt!: string | null;
}

export class ThreadResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty() blockId!: string;
  @ApiProperty({ description: 'The block is not in the document any more' }) orphaned!: boolean;
  @ApiProperty() resolved!: boolean;
  @ApiProperty({ nullable: true, type: String }) resolvedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [CommentResponse] }) comments!: CommentResponse[];
}

class MentionWarningResponse {
  @ApiProperty({
    enum: ['MENTION_IGNORED', 'MENTION_LIMIT'],
    description:
      '`MENTION_IGNORED`: the user does not exist or cannot view the document. `MENTION_LIMIT`: more than 20 mentions.',
  })
  code!: 'MENTION_IGNORED' | 'MENTION_LIMIT';
  @ApiProperty({ format: 'uuid' }) userId!: string;
}

export class ThreadWriteResponse {
  @ApiProperty({ type: ThreadResponse }) thread!: ThreadResponse;
  @ApiProperty({ type: [MentionWarningResponse] }) warnings!: MentionWarningResponse[];
}

export class CommentWriteResponse {
  @ApiProperty({ type: CommentResponse }) comment!: CommentResponse;
  @ApiProperty({ type: [MentionWarningResponse] }) warnings!: MentionWarningResponse[];
}

export class MentionableUserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
}
