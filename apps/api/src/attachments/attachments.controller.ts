import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ParseUuidPipe } from '@collab-docs/shared/nest';
import { CurrentUser, type RequestUser } from '../auth';
import { DocumentAccess } from '../permissions';
import {
  AttachmentResponse,
  AttachmentUrlResponse,
  PresignAttachmentDto,
  PresignedAttachmentResponse,
} from './attachments.dto';
import { AttachmentsService } from './attachments.service';

@ApiTags('attachments')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post('documents/:id/attachments/presign')
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Get a one-time form to upload an image straight to storage',
    description:
      'Needs EDIT. Only png, jpeg, webp and gif up to the configured size are accepted. The size is ' +
      'reserved against the workspace quota; the returned policy pins the key, the content type and the ' +
      'exact length. POST `fields` followed by the file to `url`, then call `complete`.',
  })
  @ApiCreatedResponse({ type: PresignedAttachmentResponse })
  @ApiForbiddenResponse({ description: 'PLAN_LIMIT_EXCEEDED with `details.kind = "storage"`' })
  @ApiPayloadTooLargeResponse({ description: 'The file is larger than the per-file limit' })
  presign(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: PresignAttachmentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.attachments.presign(id, user.id, dto);
  }

  @Post('attachments/:id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify an uploaded image and make it usable',
    description:
      'Needs EDIT on the document. Checks the stored size, content type and magic number; a file that ' +
      'does not match what was declared is deleted. Calling it again for a completed upload is a no-op.',
  })
  @ApiOkResponse({ type: AttachmentResponse })
  @ApiUnprocessableEntityResponse({
    description: 'The upload is missing or does not match (`details.reason`)',
  })
  complete(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.attachments.complete(id, user.id);
  }

  @Get('attachments/:id/url')
  @ApiOperation({
    summary: 'Short-lived URL to read an image',
    description: 'Needs VIEW on the document the image belongs to. The URL is valid for 5 minutes.',
  })
  @ApiOkResponse({ type: AttachmentUrlResponse })
  url(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.attachments.url(id, user.id);
  }
}
