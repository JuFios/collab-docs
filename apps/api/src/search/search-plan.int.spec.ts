import { Prisma, type PrismaClient } from '@collab-docs/db';
import { type TestDb, createTestDb, makeUser, makeWorkspace } from '@collab-docs/db/testing';
import { buildSearchStatement, searchTsquery } from './search.service';

/** Which relations/indexes a plan reads, wherever they are in the tree. */
function scans(plan: unknown): Array<{ node: string; index?: string; relation?: string }> {
  if (typeof plan !== 'object' || plan === null) return [];
  const found: Array<{ node: string; index?: string; relation?: string }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node['Node Type'] === 'string') {
      found.push({
        node: node['Node Type'],
        index: node['Index Name'] as string | undefined,
        relation: node['Relation Name'] as string | undefined,
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(plan);
  return found;
}

describe('search statement plan', () => {
  let db: TestDb;
  let prisma: PrismaClient;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDb();
    prisma = db.prisma;
    const { workspace, owner } = await makeWorkspace(prisma);
    workspaceId = workspace.id;
    userId = (await makeUser(prisma)).id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'EDITOR' } });
    // a workspace of 20 000 documents; the word "zebrafish" is in 5 of them, "filler" in all
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO documents (id, workspace_id, title, position, created_by, updated_at)
      SELECT gen_random_uuid(), ${workspaceId}::uuid, 'Document ' || n, 'a' || n, ${owner.id}::uuid, now()
      FROM generate_series(1, 20000) AS n`);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO document_search (document_id, workspace_id, title, body, indexed_revision)
      SELECT id, workspace_id, title,
             'filler text number ' || row_number() OVER () || ' lorem ipsum dolor sit amet' ||
             CASE WHEN row_number() OVER () % 4000 = 0 THEN ' zebrafish' ELSE '' END,
             0
      FROM documents WHERE workspace_id = ${workspaceId}::uuid`);
    await prisma.$executeRaw(Prisma.sql`ANALYZE`);
  });

  afterAll(async () => {
    await db.close();
  });

  /** The plan of a statement, with sequential scans switched off for the transaction. */
  function planOf(statement: Prisma.Sql) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL enable_seqscan = off`);
      const [row] = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${statement}`,
      );
      return scans(row!['QUERY PLAN']);
    });
  }

  // Sequential scans are switched off because, for a prefix query, Postgres has no better estimate than a fixed
  // fraction of the table and on a table this small it rightly prefers reading all of it (or the index on the
  // workspace). What is checked is that the match CAN be answered from the GIN index: that nothing in it (the
  // unaccent wrapper, the prefix terms) keeps the planner from using it.
  it.each([[['zebrafish']], [['Zebrafish', 'Café']]])(
    'matches %j through the GIN index of the text',
    async (tokens) => {
      const nodes = await planOf(
        Prisma.sql`SELECT ds.document_id FROM document_search ds WHERE ds.tsv @@ ${searchTsquery(tokens)}`,
      );
      expect(nodes).toContainEqual(
        expect.objectContaining({ node: 'Bitmap Index Scan', index: 'document_search_tsv_idx' }),
      );
    },
  );

  it('does not read the table of the index sequentially in the whole statement', async () => {
    const nodes = await planOf(
      buildSearchStatement({
        userId,
        workspaceId,
        tokens: ['zebrafish'],
        limit: 21,
        cursor: null,
      }),
    );
    expect(nodes).not.toContainEqual(
      expect.objectContaining({ node: 'Seq Scan', relation: 'document_search' }),
    );
  });

  it('finds the rows through the query as well', async () => {
    const statement = buildSearchStatement({
      userId,
      workspaceId,
      tokens: ['zebrafish'],
      limit: 21,
      cursor: null,
    });
    const rows = await prisma.$queryRaw<unknown[]>(statement);
    expect(rows).toHaveLength(5);
  });
});
