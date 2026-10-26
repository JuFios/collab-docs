import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ParseUuidPipe } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { CurrentDocumentAccess, DocumentAccess } from '../permissions/permissions.decorators';
import { type DocumentAccessResult } from '../permissions/permissions.service';
import {
  CreateShareDto,
  ShareResponse,
  SharedDocumentResponse,
  UpdateShareDto,
} from './documents.dto';
import { SharesService } from './shares.service';

@ApiTags('shares')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class SharesController {
  constructor(@Inject(SharesService) private readonly shares: SharesService) {}

  @Get('me/shared-documents')
  @ApiOperation({ summary: 'Documents shared with the caller' })
  @ApiOkResponse({ type: [SharedDocumentResponse] })
  sharedWithMe(@CurrentUser() user: RequestUser) {
    return this.shares.sharedWith(user.id);
  }

  @Get('documents/:id/shares')
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({ summary: 'Shares of a document (MANAGE, or EDIT as the author)' })
  @ApiOkResponse({ type: [ShareResponse] })
  list(@CurrentUser() user: RequestUser, @CurrentDocumentAccess() access: DocumentAccessResult) {
    return this.shares.list(user.id, access);
  }

  @Post('documents/:id/shares')
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Share with a registered user by email',
    description: 'Unknown email: 404. An existing share is updated. Shares are not inherited.',
  })
  @ApiCreatedResponse({ type: ShareResponse })
  add(
    @Body() dto: CreateShareDto,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ) {
    return this.shares.add(user.id, access, dto.email, dto.role);
  }

  @Patch('documents/:id/shares/:userId')
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({ summary: 'Change a share role' })
  @ApiOkResponse({ type: ShareResponse })
  update(
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: UpdateShareDto,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ) {
    return this.shares.update(user.id, access, userId, dto.role);
  }

  @Delete('documents/:id/shares/:userId')
  @HttpCode(204)
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({ summary: 'Revoke a share' })
  @ApiNoContentResponse()
  remove(
    @Param('userId', ParseUuidPipe) userId: string,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ): Promise<void> {
    return this.shares.remove(user.id, access, userId);
  }
}
