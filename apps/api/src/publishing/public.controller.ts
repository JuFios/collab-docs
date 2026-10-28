import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  ApiFoundResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Public, RateLimit } from '@collab-docs/nest';
import { CollabTicketResponse } from '../collab/collab-ticket.dto';
import {
  EditLinkStateResponse,
  PublicDocumentResponse,
  PublicMediaQueryDto,
} from './public-links.dto';
import { EditTokenPipe, PublicSlugPipe } from './public-params.pipe';
import { PublicService } from './public.service';

/** Anonymous endpoints behind `/published/<slug>` and `/edit-link/<token>`. No cookies, no user: nothing here depends on who asks. */
@ApiTags('public')
@Public()
@Controller('public')
export class PublicController {
  constructor(private readonly publicApi: PublicService) {}

  @Get('documents/:slug')
  @ApiOperation({
    summary: 'Sanitised content of a published page',
    description:
      'Title, description for the meta tags and content as sanitised ProseMirror JSON. One 404 for a page ' +
      'that was never published, was unpublished, has expired or whose document is deleted.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiOkResponse({ type: PublicDocumentResponse })
  @ApiNotFoundResponse({ description: 'The page is not available' })
  document(@Param('slug', PublicSlugPipe) slug: string) {
    return this.publicApi.document(slug);
  }

  @Get('media/:attachmentId')
  @Redirect()
  @ApiOperation({
    summary: 'Image of a published page',
    description:
      'Redirects (302) to a presigned URL valid for 5 minutes. The image has to belong to the document the ' +
      'slug publishes.',
  })
  @ApiParam({ name: 'attachmentId', type: String })
  @ApiFoundResponse({ description: 'Redirect to the image' })
  @ApiNotFoundResponse({ description: 'The page or the image is not available' })
  async media(
    @Param('attachmentId', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }))
    attachmentId: string,
    @Query() query: PublicMediaQueryDto,
  ) {
    return { url: await this.publicApi.mediaUrl(attachmentId, query.slug), statusCode: 302 };
  }

  @Get('links/:token')
  @ApiOperation({
    summary: 'State of an edit link',
    description:
      'For `/edit-link/<token>`. 404 for an unknown or replaced secret, 410 `LINK_EXPIRED` for an expired or revoked ' +
      'link and 410 `DOCUMENT_DELETED` for a deleted document.',
  })
  @ApiParam({ name: 'token', type: String })
  @ApiOkResponse({ type: EditLinkStateResponse })
  @ApiNotFoundResponse({ description: 'Unknown link' })
  @ApiGoneResponse({ description: 'LINK_EXPIRED or DOCUMENT_DELETED' })
  editLink(@Param('token', EditTokenPipe) token: string) {
    return this.publicApi.editLink(token);
  }

  @Post('links/:token/ticket')
  @HttpCode(200)
  @RateLimit.guestTicket()
  @ApiOperation({
    summary: 'Collab ticket for a guest with an edit link',
    description:
      'Same shape as the ticket of a signed-in user. Collab checks the link again whenever the socket is ' +
      'evaluated, so revoking or expiring it closes the session. Rate limited per IP.',
  })
  @ApiParam({ name: 'token', type: String })
  @ApiOkResponse({ type: CollabTicketResponse })
  @ApiNotFoundResponse({ description: 'Unknown link' })
  @ApiGoneResponse({ description: 'LINK_EXPIRED or DOCUMENT_DELETED' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  guestTicket(@Param('token', EditTokenPipe) token: string) {
    return this.publicApi.guestTicket(token);
  }
}
