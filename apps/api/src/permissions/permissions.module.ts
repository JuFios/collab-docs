import { Module } from '@nestjs/common';
import { DocumentAccessGuard, WorkspaceRoleGuard } from './permissions.decorators';
import { PermEventsService } from './perm-events.service';
import { PermissionsService } from './permissions.service';

@Module({
  providers: [PermissionsService, PermEventsService, WorkspaceRoleGuard, DocumentAccessGuard],
  exports: [PermissionsService, PermEventsService, WorkspaceRoleGuard, DocumentAccessGuard],
})
export class PermissionsModule {}
