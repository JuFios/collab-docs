import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { WorkspaceRole as Role } from '@collab-docs/shared';
import { ParseUuidPipe } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import {
  CurrentDocumentAccess,
  CurrentWorkspaceRole,
  DocumentAccess,
  WorkspaceRole,
} from '../permissions/permissions.decorators';
import { type DocumentAccessResult } from '../permissions/permissions.service';
import {
  CreateDocumentDto,
  DocumentResponse,
  MoveDocumentDto,
  MovedDocumentResponse,
  RecentDocumentResponse,
  RecentDocumentsQueryDto,
  TrashItemResponse,
  TreeNodeResponse,
  UpdateDocumentDto,
} from './documents.dto';
import { DocumentsService } from './documents.service';

@ApiTags('documents')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('workspaces/:workspaceId/documents')
  @WorkspaceRole('EDITOR')
  @ApiOperation({
    summary: 'Create a document',
    description:
      'Editor or above, and EDIT on the parent. The child copies the parent visibility and shares. ' +
      'Over the plan limit: 403 PLAN_LIMIT_EXCEEDED.',
  })
  @ApiCreatedResponse({ type: DocumentResponse })
  create(
    @Param('workspaceId', ParseUuidPipe) workspaceId: string,
    @Body() dto: CreateDocumentDto,
    @CurrentUser() user: RequestUser,
    @CurrentWorkspaceRole() role: Role,
  ) {
    return this.documents.create(user.id, workspaceId, role, dto);
  }

  @Get('workspaces/:workspaceId/documents/tree')
  @WorkspaceRole('VIEWER')
  @ApiOperation({
    summary: 'Flat document tree, filtered by the caller permissions',
    description:
      'Sorted by position then id. A document under an inaccessible parent is returned with parentId null.',
  })
  @ApiOkResponse({ type: [TreeNodeResponse] })
  tree(
    @Param('workspaceId', ParseUuidPipe) workspaceId: string,
    @CurrentUser() user: RequestUser,
    @CurrentWorkspaceRole() role: Role,
  ) {
    return this.documents.tree(user.id, workspaceId, role);
  }

  @Get('workspaces/:workspaceId/documents/recent')
  @WorkspaceRole('VIEWER')
  @ApiOperation({
    summary: 'Most recently changed documents the caller can open',
    description: 'Sorted by last change, newest first; only documents with VIEW or higher access.',
  })
  @ApiOkResponse({ type: [RecentDocumentResponse] })
  recent(
    @Param('workspaceId', ParseUuidPipe) workspaceId: string,
    @Query() query: RecentDocumentsQueryDto,
    @CurrentUser() user: RequestUser,
    @CurrentWorkspaceRole() role: Role,
  ) {
    return this.documents.recent(user.id, workspaceId, role, query.limit);
  }

  @Get('workspaces/:workspaceId/trash')
  @WorkspaceRole('VIEWER')
  @ApiOperation({ summary: 'Deleted documents (roots of each deletion) the caller could access' })
  @ApiOkResponse({ type: [TrashItemResponse] })
  trash(
    @Param('workspaceId', ParseUuidPipe) workspaceId: string,
    @CurrentUser() user: RequestUser,
    @CurrentWorkspaceRole() role: Role,
  ) {
    return this.documents.trash(user.id, workspaceId, role);
  }

  @Get('documents/:id')
  @DocumentAccess('VIEW', { param: 'id' })
  @ApiOperation({ summary: 'Document metadata with the caller access level' })
  @ApiOkResponse({ type: DocumentResponse })
  get(@CurrentUser() user: RequestUser, @CurrentDocumentAccess() access: DocumentAccessResult) {
    return this.documents.get(user.id, access);
  }

  @Patch('documents/:id')
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Update title, icon or visibility',
    description: 'Title and icon need EDIT; visibility needs MANAGE or EDIT as the author.',
  })
  @ApiOkResponse({ type: DocumentResponse })
  update(
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ) {
    return this.documents.update(user.id, access, dto);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Move the document and all its descendants to the trash',
    description: 'Descendants are deleted too, whether or not the caller can see them.',
  })
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() access: DocumentAccessResult,
  ): Promise<void> {
    return this.documents.remove(user.id, access);
  }

  @Post('documents/:id/restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Restore a deleted document with the descendants deleted together with it',
    description:
      'Owner, admin, or the author when an editor. Returns to the root when the parent is still deleted. ' +
      'Over the plan limit: 403 PLAN_LIMIT_EXCEEDED.',
  })
  @ApiOkResponse({ type: DocumentResponse })
  restore(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.documents.restore(user.id, id);
  }

  @Post('documents/:id/move')
  @HttpCode(200)
  @DocumentAccess('EDIT', { param: 'id' })
  @ApiOperation({
    summary: 'Move or reorder a document',
    description:
      'EDIT on the document and on the new parent, same workspace, no cycles (409). Without beforeId and afterId the document goes last.',
  })
  @ApiOkResponse({ type: MovedDocumentResponse })
  move(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: MoveDocumentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.documents.move(user.id, id, dto);
  }
}
