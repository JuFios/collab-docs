import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Access, WorkspaceRole as Role } from '@collab-docs/shared';
import { AppException } from '@collab-docs/shared/nest';
import type { RequestUser } from '../auth';
import { type DocumentAccessResult, PermissionsService } from './permissions.service';

const WORKSPACE_ROLE_KEY = 'permissions:workspaceRole';
const DOCUMENT_ACCESS_KEY = 'permissions:documentAccess';

interface Requirement<T> {
  min: T;
  /** Route parameter holding the id. */
  param: string;
}

type PermissionRequest = Request & {
  user?: RequestUser;
  /** Set by `WorkspaceRoleGuard`. */
  workspaceRole?: Role;
  /** Set by `DocumentAccessGuard`. */
  documentAccess?: DocumentAccessResult;
};

function userOf(request: PermissionRequest): RequestUser {
  if (!request.user) throw new AppException('UNAUTHENTICATED', 'Authentication required');
  return request.user;
}

function idOf(request: PermissionRequest, param: string): string {
  const value = request.params[param];
  return typeof value === 'string' ? value : '';
}

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<Requirement<Role> | undefined>(
      WORKSPACE_ROLE_KEY,
      context.getHandler(),
    );
    if (!requirement) return true;
    const request = context.switchToHttp().getRequest<PermissionRequest>();
    request.workspaceRole = await this.permissions.assertWorkspaceRole(
      userOf(request).id,
      idOf(request, requirement.param),
      requirement.min,
    );
    return true;
  }
}

@Injectable()
export class DocumentAccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<Requirement<Access> | undefined>(
      DOCUMENT_ACCESS_KEY,
      context.getHandler(),
    );
    if (!requirement) return true;
    const request = context.switchToHttp().getRequest<PermissionRequest>();
    request.documentAccess = await this.permissions.assertDocumentAccess(
      userOf(request).id,
      idOf(request, requirement.param),
      requirement.min,
    );
    return true;
  }
}

/**
 * Requires at least `min` in the workspace named by the route parameter (default `workspaceId`).
 * Non-members get 404, members below `min` get 403.
 */
export const WorkspaceRole = (min: Role, options: { param?: string } = {}) =>
  applyDecorators(
    SetMetadata(WORKSPACE_ROLE_KEY, { min, param: options.param ?? 'workspaceId' }),
    UseGuards(WorkspaceRoleGuard),
  );

/**
 * Requires at least `min` access on the document named by the route parameter (default `documentId`).
 * No access at all (including a deleted or unknown document) gives 404, insufficient access 403.
 */
export const DocumentAccess = (min: Access, options: { param?: string } = {}) =>
  applyDecorators(
    SetMetadata(DOCUMENT_ACCESS_KEY, { min, param: options.param ?? 'documentId' }),
    UseGuards(DocumentAccessGuard),
  );

/** Role resolved by `@WorkspaceRole()`. */
export function workspaceRoleOf(request: Request): Role {
  const role = (request as PermissionRequest).workspaceRole;
  if (!role) throw new AppException('INTERNAL_ERROR', 'WorkspaceRole guard missing');
  return role;
}

/** Access resolved by `@DocumentAccess()`. */
export function documentAccessOf(request: Request): DocumentAccessResult {
  const access = (request as PermissionRequest).documentAccess;
  if (!access) throw new AppException('INTERNAL_ERROR', 'DocumentAccess guard missing');
  return access;
}
