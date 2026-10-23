import { createTestDb, makeDocument, makeUser, makeWorkspace, type TestDb } from './testing';
import { PublicLinkMode, ShareRole, WorkspaceRole } from './index';

describe('core schema', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.truncate();
  });

  const indexes = async (table: string): Promise<{ indexname: string; indexdef: string }[]> =>
    db.prisma
      .$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;

  it('applies migrations to an empty database with the expected extensions', async () => {
    const ext = await db.prisma.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension`;
    expect(ext.map((e) => e.extname)).toEqual(expect.arrayContaining(['pg_trgm', 'unaccent']));
  });

  describe('uniqueness', () => {
    it('rejects duplicate user emails', async () => {
      await makeUser(db.prisma, { email: 'dup@example.test' });
      await expect(makeUser(db.prisma, { email: 'dup@example.test' })).rejects.toThrow();
    });

    it('rejects duplicate workspace slugs', async () => {
      await makeWorkspace(db.prisma, { slug: 'same' });
      await expect(makeWorkspace(db.prisma, { slug: 'same' })).rejects.toThrow();
    });

    it('rejects a second membership of the same user', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      await expect(
        db.prisma.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: owner.id, role: WorkspaceRole.EDITOR },
        }),
      ).rejects.toThrow();
    });

    it('rejects a duplicate share for the same document and user', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const guest = await makeUser(db.prisma);
      const doc = await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id });
      const data = { documentId: doc.id, userId: guest.id, role: ShareRole.VIEWER };
      await db.prisma.documentShare.create({ data });
      await expect(db.prisma.documentShare.create({ data })).rejects.toThrow();
    });

    it('allows one public link per (document, mode) and unique slugs', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const doc = await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id });
      const other = await makeDocument(db.prisma, {
        workspaceId: workspace.id,
        createdBy: owner.id,
      });
      const base = { createdBy: owner.id };
      await db.prisma.publicLink.create({
        data: { ...base, documentId: doc.id, mode: PublicLinkMode.VIEW, slug: 's1' },
      });
      await db.prisma.publicLink.create({
        data: { ...base, documentId: doc.id, mode: PublicLinkMode.EDIT, tokenHash: 't1' },
      });
      await expect(
        db.prisma.publicLink.create({
          data: { ...base, documentId: doc.id, mode: PublicLinkMode.VIEW, slug: 's2' },
        }),
      ).rejects.toThrow();
      await expect(
        db.prisma.publicLink.create({
          data: { ...base, documentId: other.id, mode: PublicLinkMode.VIEW, slug: 's1' },
        }),
      ).rejects.toThrow();
    });

    it('rejects duplicate refresh-token hashes and invite token hashes', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const expiresAt = new Date(Date.now() + 60_000);
      const token = { userId: owner.id, familyId: owner.id, tokenHash: 'h', expiresAt };
      await db.prisma.refreshToken.create({ data: token });
      await expect(db.prisma.refreshToken.create({ data: token })).rejects.toThrow();
      const invite = {
        workspaceId: workspace.id,
        email: 'x@example.test',
        role: WorkspaceRole.EDITOR,
        tokenHash: 'i',
        expiresAt,
        invitedBy: owner.id,
      };
      await db.prisma.workspaceInvite.create({ data: invite });
      await expect(db.prisma.workspaceInvite.create({ data: invite })).rejects.toThrow();
    });
  });

  describe('defaults', () => {
    it('creates workspaces on the FREE plan', async () => {
      const { workspace } = await makeWorkspace(db.prisma);
      const sub = await db.prisma.subscription.findUniqueOrThrow({
        where: { workspaceId: workspace.id },
      });
      expect(sub.plan).toBe('FREE');
      expect(sub.status).toBe('ACTIVE');
    });

    it('generates uuid v7 ids and a zero revision', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const doc = await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id });
      expect(doc.id[14]).toBe('7');
      expect(doc.revision).toBe(0n);
      expect(doc.visibility).toBe('WORKSPACE');
    });
  });

  describe('indexes', () => {
    it('has the tree index as a partial index', async () => {
      const found = (await indexes('documents')).find((i) => i.indexname === 'documents_tree_idx');
      expect(found?.indexdef).toMatch(/WHERE \(?"?deleted_at"? IS NULL\)?/);
    });

    it('has the remaining spec indexes', async () => {
      const names = async (t: string): Promise<string[]> =>
        (await indexes(t)).map((i) => i.indexname);
      expect(await names('documents')).toEqual(
        expect.arrayContaining([
          'documents_workspace_id_deleted_at_idx',
          'documents_parent_id_idx',
        ]),
      );
      expect(await names('refresh_tokens')).toEqual(
        expect.arrayContaining([
          'refresh_tokens_user_id_idx',
          'refresh_tokens_family_id_idx',
          'refresh_tokens_token_hash_key',
        ]),
      );
      expect(await names('workspace_members')).toEqual(
        expect.arrayContaining(['workspace_members_user_id_idx']),
      );
      expect(await names('workspace_invites')).toEqual(
        expect.arrayContaining([
          'workspace_invites_workspace_id_email_idx',
          'workspace_invites_token_hash_key',
        ]),
      );
      expect(await names('document_shares')).toEqual(
        expect.arrayContaining(['document_shares_user_id_idx']),
      );
    });

    it('uses the tree index for "children of a document"', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      // many parents with a handful of children each, like a real tree
      const parents = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          makeDocument(db.prisma, {
            workspaceId: workspace.id,
            createdBy: owner.id,
            position: `p${String(i).padStart(3, '0')}`,
          }),
        ),
      );
      await db.prisma.document.createMany({
        data: Array.from({ length: 2000 }, (_, i) => ({
          workspaceId: workspace.id,
          createdBy: owner.id,
          parentId: (parents[i % parents.length] as { id: string }).id,
          position: `a${String(i).padStart(4, '0')}`,
        })),
      });
      await db.prisma.$executeRawUnsafe('ANALYZE documents');
      const plan = await db.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN SELECT id FROM documents WHERE workspace_id = '${workspace.id}' AND parent_id = '${(parents[0] as { id: string }).id}' AND deleted_at IS NULL ORDER BY position`,
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).toMatch(/documents_tree_idx/);
    });
  });

  describe('ordering', () => {
    it('sorts fractional-indexing keys bytewise (COLLATE "C")', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      // Under a locale collation "a0" < "B0" < "a1"; bytewise (and fractional-indexing) order is "B0" < "a0" < "a1".
      const positions = ['a1', 'a0', 'B0', 'Zz', 'a0V'];
      for (const position of positions) {
        await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id, position });
      }
      const rows = await db.prisma.$queryRaw<
        { position: string }[]
      >`SELECT position FROM documents ORDER BY position`;
      expect(rows.map((r) => r.position)).toEqual([...positions].sort());
    });
  });

  describe('foreign keys', () => {
    it('cascades workspace deletion to members, invites and subscription but is blocked by documents', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id });
      await expect(db.prisma.workspace.delete({ where: { id: workspace.id } })).rejects.toThrow();
      await db.prisma.document.deleteMany({});
      await db.prisma.workspace.delete({ where: { id: workspace.id } });
      expect(await db.prisma.workspaceMember.count()).toBe(0);
      expect(await db.prisma.subscription.count()).toBe(0);
    });

    it('cascades document deletion to shares and public links', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const guest = await makeUser(db.prisma);
      const doc = await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id });
      await db.prisma.documentShare.create({
        data: { documentId: doc.id, userId: guest.id, role: ShareRole.EDITOR },
      });
      await db.prisma.publicLink.create({
        data: { documentId: doc.id, mode: PublicLinkMode.VIEW, slug: 'x', createdBy: owner.id },
      });
      await db.prisma.document.delete({ where: { id: doc.id } });
      expect(await db.prisma.documentShare.count()).toBe(0);
      expect(await db.prisma.publicLink.count()).toBe(0);
    });

    it('restricts deleting a document that has children and a user who owns a workspace', async () => {
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const parent = await makeDocument(db.prisma, {
        workspaceId: workspace.id,
        createdBy: owner.id,
      });
      await makeDocument(db.prisma, {
        workspaceId: workspace.id,
        createdBy: owner.id,
        parentId: parent.id,
      });
      await expect(db.prisma.document.delete({ where: { id: parent.id } })).rejects.toThrow();
      await expect(db.prisma.user.delete({ where: { id: owner.id } })).rejects.toThrow();
    });

    it("removes a user's refresh tokens and memberships with the user", async () => {
      const { workspace } = await makeWorkspace(db.prisma);
      const member = await makeUser(db.prisma);
      await db.prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: member.id, role: WorkspaceRole.VIEWER },
      });
      await db.prisma.refreshToken.create({
        data: { userId: member.id, familyId: member.id, tokenHash: 'z', expiresAt: new Date() },
      });
      await db.prisma.user.delete({ where: { id: member.id } });
      expect(await db.prisma.refreshToken.count()).toBe(0);
      expect(await db.prisma.workspaceMember.count({ where: { userId: member.id } })).toBe(0);
    });
  });
});
