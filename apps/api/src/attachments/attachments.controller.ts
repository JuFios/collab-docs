import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AttachmentAccess, CurrentAttachment, type AttachmentRow } from './attachment-access';
import { AttachmentResponse, AttachmentUrlResponse } from './attachments.dto';
import { AttachmentsService } from './attachments.service';

@ApiTags('attachments')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@ApiParam({ name: 'id', type: String })
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post(':id/complete')
  @HttpCode(200)
  @AttachmentAccess('EDIT')
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
  complete(@CurrentAttachment() attachment: AttachmentRow) {
    return this.attachments.complete(attachment);
  }

  @Get(':id/url')
  @AttachmentAccess('VIEW')
  @ApiOperation({
    summary: 'Short-lived URL to read an image',
    description: 'Needs VIEW on the document the image belongs to. The URL is valid for 5 minutes.',
  })
  @ApiOkResponse({ type: AttachmentUrlResponse })
  url(@CurrentAttachment() attachment: AttachmentRow) {
    return this.attachments.url(attachment);
  }
}
