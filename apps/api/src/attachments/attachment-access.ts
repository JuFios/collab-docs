import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Access } from '@collab-docs/shared';
import { AppException, ParseUuidPipe } from '@collab-docs/nest';
import type { Request } from 'express';
import type { RequestUser } from '../auth/auth.types';
import {
  type DocumentAccessResult,
  PermissionsService,
  notFound,
} from '../permissions/permissions.service';
import { PrismaService } from '../prisma/prisma.service';

const ATTACHMENT_ACCESS_KEY = 'attachments:access';

/** What the attachment endpoints and the service work with: the row, never the object-store credentials. */
export interface AttachmentRow {
  id: string;
  documentId: string;
  key: string;
  mime: string;
  size: number;
  status: 'PENDING' | 'READY';
  createdAt: Date;
}

interface AttachmentRequest extends Request {
  user?: RequestUser;
  /** Set by `AttachmentAccessGuard`. */
  attachment?: AttachmentRow;
  /** The caller's access to the attachment's document, set by `AttachmentAccessGuard`. */
  attachmentDocumentAccess?: DocumentAccessResult;
}

interface Requirement {
  min: Access;
  /** Route parameter holding the attachment id. */
  param: string;
}

@Injectable()
export class AttachmentAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<Requirement | undefined>(
      ATTACHMENT_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true;
    const request = context.switchToHttp().getRequest<AttachmentRequest>();
    if (!request.user) throw new AppException('UNAUTHENTICATED', 'Authentication required');

    // guards run before pipes, so the id is validated here with the pipe the route would have used
    const raw = request.params[requirement.param];
    const id = await new ParseUuidPipe().transform(typeof raw === 'string' ? raw : '', {
      type: 'param',
      data: requirement.param,
    });
    const row = await this.prisma.attachment.findUnique({
      where: { id },
      select: {
        id: true,
        documentId: true,
        key: true,
        mime: true,
        size: true,
        status: true,
        createdAt: true,
      },
    });
    if (!row) throw notFound('Attachment');

    request.attachmentDocumentAccess = await this.permissions.assertDocumentAccess(
      request.user.id,
      row.documentId,
      requirement.min,
    );
    request.attachment = row;
    return true;
  }
}

/**
 * Requires at least `min` access on the document an attachment belongs to (the attachment is named by the route
 * parameter, default `id`). An unknown attachment, or one in a document the caller cannot see, gives 404.
 */
export const AttachmentAccess = (min: Access, options: { param?: string } = {}) =>
  applyDecorators(
    SetMetadata(ATTACHMENT_ACCESS_KEY, { min, param: options.param ?? 'id' }),
    UseGuards(AttachmentAccessGuard),
  );

/** The attachment loaded by `@AttachmentAccess()`. */
export const CurrentAttachment = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AttachmentRow => {
    const attachment = context.switchToHttp().getRequest<AttachmentRequest>().attachment;
    if (!attachment) throw new AppException('INTERNAL_ERROR', 'AttachmentAccess guard missing');
    return attachment;
  },
);
