import '../test/workspaces-env';
import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import request from 'supertest';
import { PrismaClient } from '@collab-docs/db';
import { signAccessToken } from '@collab-docs/shared';
import { createTestApp } from '../test/test-app';
import { DocumentAccess } from './permissions.decorators';

@Controller('test-docs')
class DocsController {
  @Get(':documentId')
  @DocumentAccess('VIEW')
  read(@Param('documentId') id: string) {
    return { id };
  }

  @Post(':documentId')
  @DocumentAccess('EDIT')
  write(@Param('documentId') id: string, @Req() req: Request) {
    return {
      id,
      access: (req as Request & { documentAccess: { access: string } }).documentAccess.access,
    };
  }

  @Post(':documentId/publish')
  @DocumentAccess('MANAGE')
  manage(@Param('documentId') id: string) {
    return { id };
  }
}

describe('document access guard (database-backed)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let counter = 0;

  const token = async (userId: string) =>
    (await signAccessToken(process.env.JWT_ACCESS_SECRET as string, userId)).token;
  const call = async (method: 'get' | 'post', userId: string, path: string) => {
    const server = app.getHttpServer();
    const url = `/api/test-docs${path}`;
    const auth = `Bearer ${await token(userId)}`;
    if (method === 'get') return request(server).get(url).set('Authorization', auth);
    return request(server).post(url).set('Authorization', auth);
  };

  async function user() {
    return prisma.user.create({
      data: {
        email: `perm-${Date.now()}-${counter++}@perm-test.example`,
        name: 'u',
        passwordHash: 'x',
      },
    });
  }

  beforeAll(async () => {
    app = await createTestApp([DocsController]);
    prisma = app.get(PrismaClient, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps roles, visibility, shares and deletion to 200 / 403 / 404', async () => {
    const [owner, editor, viewer, guest, outsider] = await Promise.all([1, 2, 3, 4, 5].map(user));
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Perm',
        slug: `perm-${Date.now()}-${counter++}`,
        ownerId: owner!.id,
        subscription: { create: {} },
        members: {
          create: [
            { userId: owner!.id, role: 'OWNER' },
            { userId: editor!.id, role: 'EDITOR' },
            { userId: viewer!.id, role: 'VIEWER' },
          ],
        },
      },
    });
    const doc = (data: object) =>
      prisma.document.create({
        data: { workspaceId: workspace.id, createdBy: owner!.id, position: 'a0', ...data },
      });
    const open = await doc({});
    const restricted = await doc({ visibility: 'RESTRICTED' });
    const deleted = await doc({ deletedAt: new Date() });
    await prisma.documentShare.createMany({
      data: [
        { documentId: restricted.id, userId: guest!.id, role: 'EDITOR' },
        { documentId: restricted.id, userId: viewer!.id, role: 'VIEWER' },
        { documentId: open.id, userId: guest!.id, role: 'VIEWER' },
      ],
    });

    // POST handlers answer 201; only the success/denial distinction matters here
    const status = async (userId: string, method: 'get' | 'post', path: string) => {
      const code = (await call(method, userId, path)).status;
      return code === 201 ? 200 : code;
    };

    // workspace-visible document
    expect(await status(owner!.id, 'post', `/${open.id}/publish`)).toBe(200);
    expect(await status(editor!.id, 'post', `/${open.id}`)).toBe(200);
    expect(await status(editor!.id, 'post', `/${open.id}/publish`)).toBe(403);
    expect(await status(viewer!.id, 'get', `/${open.id}`)).toBe(200);
    expect(await status(viewer!.id, 'post', `/${open.id}`)).toBe(403);
    expect(await status(outsider!.id, 'get', `/${open.id}`)).toBe(404);
    // a guest with a viewer share reads but cannot edit
    expect(await status(guest!.id, 'get', `/${open.id}`)).toBe(200);
    expect(await status(guest!.id, 'post', `/${open.id}`)).toBe(403);

    // restricted: only owner/admin and shared users
    expect(await status(editor!.id, 'get', `/${restricted.id}`)).toBe(404);
    expect(await status(guest!.id, 'post', `/${restricted.id}`)).toBe(200);
    expect(await status(viewer!.id, 'get', `/${restricted.id}`)).toBe(200);
    expect(await status(viewer!.id, 'post', `/${restricted.id}`)).toBe(403);
    expect(await status(owner!.id, 'post', `/${restricted.id}`)).toBe(200);

    // deleted documents and unknown ids look the same to everybody, owners included
    const missing = await call('get', owner!.id, '/0190b1c2-0000-7000-8000-0000000000cc');
    const gone = await call('get', owner!.id, `/${deleted.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ ...missing.body, correlationId: gone.body.correlationId });
    expect(await status(owner!.id, 'get', '/not-a-uuid')).toBe(404);

    // permissions are not cached: removing the share takes effect on the next request
    await prisma.documentShare.deleteMany({
      where: { documentId: restricted.id, userId: guest!.id },
    });
    expect(await status(guest!.id, 'post', `/${restricted.id}`)).toBe(404);
  });
});
