import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ParseUuidPipe } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { DocumentAccess } from '../permissions/permissions.decorators';
import { PresignAttachmentDto, PresignedAttachmentResponse } from './attachments.dto';
import { AttachmentsService } from './attachments.service';

@ApiTags('attachments')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('documents/:id/attachments')
export class DocumentAttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post('presign')
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
}
