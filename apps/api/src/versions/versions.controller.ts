import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ParseUuidPipe } from '@collab-docs/shared/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { DocumentAccess } from '../permissions/permissions.decorators';
import {
  CreateVersionDto,
  CreatedVersionResponse,
  RestoredVersionResponse,
  VersionContentResponse,
  VersionResponse,
} from './versions.dto';
import { VersionsService } from './versions.service';

@ApiTags('versions')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('documents/:id/versions')
export class VersionsController {
  constructor(@Inject(VersionsService) private readonly versions: VersionsService) {}

  @Get()
  @DocumentAccess('VIEW', { param: 'id' })
  @ApiOperation({
    summary: 'Version history, newest first',
    description:
      'Automatic snapshots (every 10 minutes while the document changes, 50 kept), manual ones and the ' +
      'snapshots taken before a restore.',
  })
  @ApiOkResponse({ type: [VersionResponse] })
  list(@Param('id', ParseUuidPipe) id: string) {
    return this.versions.list(id);
  }

  @Get(':versionId')
  @DocumentAccess('VIEW', { param: 'id' })
  @ApiOperation({ summary: 'One version with its content as sanitised ProseMirror JSON' })
  @ApiOkResponse({ type: VersionContentResponse })
  get(
    @Param('id', ParseUuidPipe) id: string,
    @Param('versionId', ParseUuidPipe) versionId: string,
  ) {
    return this.versions.get(id, versionId);
  }

  @Post()
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Save the current content as a named version',
    description:
      'Needs EDIT. The collaboration service is asked to write its buffer first (2 s limit); if it cannot ' +
      'be reached the stored state is snapshotted and `flushed` is false. At most 100 saved versions per document.',
  })
  @ApiCreatedResponse({ type: CreatedVersionResponse })
  @ApiConflictResponse({ description: 'The document already has 100 saved versions' })
  create(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateVersionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.versions.createManual(id, user.id, dto.label);
  }

  @Post(':versionId/restore')
  @HttpCode(200)
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Replace the content with a version',
    description:
      'Needs EDIT. The current content is saved as a "before restore" version first; connected editors ' +
      'converge on the restored content and the history is not rewritten.',
  })
  @ApiOkResponse({ type: RestoredVersionResponse })
  @ApiServiceUnavailableResponse({ description: 'The collaboration service is not available' })
  restore(
    @Param('id', ParseUuidPipe) id: string,
    @Param('versionId', ParseUuidPipe) versionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.versions.restore(id, versionId, user.id);
  }
}
