import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ParseUuidPipe, RateLimit } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { DocumentAccess } from '../permissions/permissions.decorators';
import {
  CommentWriteResponse,
  CreateCommentDto,
  CreateThreadDto,
  ListThreadsQueryDto,
  MentionableQueryDto,
  MentionableUserResponse,
  ThreadResponse,
  ThreadWriteResponse,
  UpdateCommentDto,
} from './comments.dto';
import { CommentsService } from './comments.service';

@ApiTags('comments')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('documents/:id/threads')
  @DocumentAccess('VIEW', { param: 'id' })
  @ApiOperation({
    summary: 'Comment threads of a document',
    description:
      'Oldest thread first, each with its comments. A thread whose block is no longer in the document has ' +
      '`orphaned: true`. Deleted comments stay in their thread as blank placeholders. Anyone who can view the document reads.',
  })
  @ApiOkResponse({ type: [ThreadResponse] })
  threads(@Param('id', ParseUuidPipe) id: string, @Query() query: ListThreadsQueryDto) {
    return this.comments.listThreads(id, query.status);
  }

  @Post('documents/:id/threads')
  @DocumentAccess('COMMENT', { param: 'id' })
  // below the access decorator on purpose: guards run bottom-up, and a probe of somebody else's id must count
  @RateLimit.user('comment')
  @ApiOperation({
    summary: 'Start a thread on a block',
    description:
      'Needs permission to comment (editors and up; viewers get 403). Mentioned users who can view the document ' +
      'get a notification and an email.',
  })
  @ApiCreatedResponse({ type: ThreadWriteResponse })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  createThread(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateThreadDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.comments.createThread(user.id, id, dto);
  }

  @Get('documents/:id/mentionable')
  @DocumentAccess('COMMENT', { param: 'id' })
  @ApiOperation({
    summary: 'Users that can be mentioned in a comment',
    description:
      'People who can view the document, filtered by the start of a name or an email; at most 10.',
  })
  @ApiOkResponse({ type: [MentionableUserResponse] })
  mentionable(@Param('id', ParseUuidPipe) id: string, @Query() query: MentionableQueryDto) {
    return this.comments.mentionable(id, query.q);
  }

  @Post('threads/:threadId/comments')
  @RateLimit.user('comment')
  @ApiOperation({
    summary: 'Reply in a thread',
    description: 'Needs permission to comment on the document.',
  })
  @ApiParam({ name: 'threadId', format: 'uuid' })
  @ApiCreatedResponse({ type: CommentWriteResponse })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  reply(
    @Param('threadId', ParseUuidPipe) threadId: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.comments.reply(user.id, threadId, dto);
  }

  @Post('threads/:threadId/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve a thread',
    description: 'Idempotent. Needs permission to comment.',
  })
  @ApiParam({ name: 'threadId', format: 'uuid' })
  @ApiOkResponse({ type: ThreadResponse })
  resolve(@Param('threadId', ParseUuidPipe) threadId: string, @CurrentUser() user: RequestUser) {
    return this.comments.setResolved(user.id, threadId, true);
  }

  @Post('threads/:threadId/reopen')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reopen a resolved thread',
    description: 'Idempotent. Needs permission to comment.',
  })
  @ApiParam({ name: 'threadId', format: 'uuid' })
  @ApiOkResponse({ type: ThreadResponse })
  reopen(@Param('threadId', ParseUuidPipe) threadId: string, @CurrentUser() user: RequestUser) {
    return this.comments.setResolved(user.id, threadId, false);
  }

  @Patch('comments/:commentId')
  @RateLimit.user('comment')
  @ApiOperation({
    summary: 'Edit a comment',
    description:
      'Author only. A user mentioned for the first time is notified; saving the same mention again is not a new notification.',
  })
  @ApiParam({ name: 'commentId', format: 'uuid' })
  @ApiOkResponse({ type: CommentWriteResponse })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  edit(
    @Param('commentId', ParseUuidPipe) commentId: string,
    @Body() dto: UpdateCommentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.comments.edit(user.id, commentId, dto);
  }

  @Delete('comments/:commentId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a comment',
    description:
      'The author, or an owner/admin of the workspace. The text is erased and the notifications it caused are removed; ' +
      'a thread without comments is no longer listed.',
  })
  @ApiParam({ name: 'commentId', format: 'uuid' })
  @ApiNoContentResponse()
  async remove(
    @Param('commentId', ParseUuidPipe) commentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.comments.remove(user.id, commentId);
  }
}
