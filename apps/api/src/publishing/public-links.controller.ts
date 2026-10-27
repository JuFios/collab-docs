import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ParseUuidPipe, RateLimit } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { CurrentDocumentAccess, DocumentAccess } from '../permissions/permissions.decorators';
import { type DocumentAccessResult } from '../permissions/permissions.service';
import {
  CreatePublicLinkDto,
  CreatedPublicLinkResponse,
  PublicLinkResponse,
  UpdatePublicLinkDto,
} from './public-links.dto';
import { PublicLinksService } from './public-links.service';

@ApiTags('publishing')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('documents/:id/public-links')
export class PublicLinksController {
  constructor(private readonly links: PublicLinksService) {}

  @Get()
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Public links of a document (MANAGE, or EDIT as the author)',
    description:
      'At most one VIEW link (the published page) and one EDIT link. The EDIT secret is not listed: it is ' +
      'shown once, when the link is created.',
  })
  @ApiOkResponse({ type: [PublicLinkResponse] })
  list(@CurrentUser() user: RequestUser, @CurrentDocumentAccess() access: DocumentAccessResult) {
    return this.links.list(user.id, access);
  }

  @Post()
  @DocumentAccess('EDIT', { param: 'id' })
  // below the access decorator on purpose: guards run bottom-up, and a probe of somebody else's id must count
  @RateLimit.user('publicLink')
  @ApiOperation({
    summary: 'Publish the page (VIEW) or enable editing by link (EDIT)',
    description:
      'MANAGE, or EDIT as the author; 10 per hour per user. VIEW: collab is asked to write its buffer ' +
      'first (2 s; `flushed` is false when it could not), the slug is created once and returned again ' +
      'when the page is published again. EDIT: every call issues a new secret and invalidates the ' +
      'previous URL, closing its open guest sessions.',
  })
  @ApiCreatedResponse({ type: CreatedPublicLinkResponse })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  create(
    @Body() dto: CreatePublicLinkDto,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ) {
    return this.links.create(user.id, access, dto);
  }

  @Patch(':linkId')
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({ summary: 'Change or remove the expiry of a link' })
  @ApiOkResponse({ type: PublicLinkResponse })
  @ApiConflictResponse({ description: 'The link was revoked' })
  update(
    @Param('linkId', ParseUuidPipe) linkId: string,
    @Body() dto: UpdatePublicLinkDto,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ) {
    return this.links.update(user.id, access, linkId, dto.expiresAt);
  }

  @Delete(':linkId')
  @HttpCode(204)
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Revoke a link',
    description:
      'Unpublishes the page (the slug stays reserved for it) or ends editing by link. Revoking an already ' +
      'revoked link does nothing.',
  })
  @ApiNoContentResponse()
  async revoke(
    @Param('linkId', ParseUuidPipe) linkId: string,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ): Promise<void> {
    await this.links.revoke(user.id, access, linkId);
  }
}
