import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import {
  ListNotificationsQueryDto,
  MarkReadDto,
  MarkReadResponse,
  NotificationPageResponse,
  UnreadCountResponse,
} from './inbox.dto';
import { InboxService } from './inbox.service';

@ApiTags('notifications')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('notifications')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOperation({
    summary: 'Notifications of the caller, newest first',
    description:
      'From every workspace. A notification about a document the caller can no longer open is not listed.',
  })
  @ApiOkResponse({ type: NotificationPageResponse })
  list(@Query() query: ListNotificationsQueryDto, @CurrentUser() user: RequestUser) {
    return this.inbox.list(user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications that the list shows' })
  @ApiOkResponse({ type: UnreadCountResponse })
  async unreadCount(@CurrentUser() user: RequestUser) {
    return { count: await this.inbox.unreadCount(user.id) };
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark notifications as read',
    description:
      'Pass `ids` (up to 100) or `all: true`. Only the caller’s own notifications are affected.',
  })
  @ApiOkResponse({ type: MarkReadResponse })
  async markRead(@Body() dto: MarkReadDto, @CurrentUser() user: RequestUser) {
    return { updated: await this.inbox.markRead(user.id, dto) };
  }
}
