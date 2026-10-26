export { PermissionsModule } from './permissions.module';
export {
  PermissionsService,
  notFound,
  type Db,
  type DocumentAccessResult,
} from './permissions.service';
export { PermEventsService } from './perm-events.service';
export {
  CurrentDocumentAccess,
  CurrentWorkspaceRole,
  DocumentAccess,
  WorkspaceRole,
} from './permissions.decorators';
