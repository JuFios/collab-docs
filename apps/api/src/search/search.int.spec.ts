import '../test/env/search';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as Y from 'yjs';
import {
  DocumentStateReader,
  DocumentStateWriter,
  Prisma,
  type PrismaClient,
} from '@collab-docs/db';
import type { SearchPage, SnippetPart } from '@collab-docs/shared';
import { MetricsService, QueueService, emitDocumentChanged } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_INDEXED_BODY_CHARS, SearchIndexService } from './search-index.service';
import { SearchWorkerModule } from './search.module';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';

interface TestUser {
  id: string;
  token: string;
  email: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await wait(25);
  }
}

const textOf = (parts: SnippetPart[]) => parts.map((part) => part.text).join('');
const matchesOf = (parts: SnippetPart[]) => parts.filter((part) => part.match).map((p) => p.text);

describe('search', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let writer: DocumentStateWriter;
  let reader: DocumentStateReader;
  let indexer: SearchIndexService;
  let queues: QueueService;
  let counter = 0;
  const drafts = new Map<string, Y.Doc>();

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@search-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.5.${counter % 250}.${(counter * 7) % 250}`)
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    return { id: response.body.user.id, email, token: response.body.accessToken };
  }

  const as = (user: TestUser | null) => {
    const auth = <T extends request.Test>(req: T): T =>
      (user ? req.set('Authorization', `Bearer ${user.token}`) : req) as T;
    return {
      get: (path: string) => auth(http$().get(`/api${path}`)),
      post: (path: string) => auth(http$().post(`/api${path}`)),
      patch: (path: string) => auth(http$().patch(`/api${path}`)),
      delete: (path: string) => auth(http$().delete(`/api${path}`)),
    };
  };

  /** An owner with a workspace; an admin, an editor and a viewer in it; a guest and an outsider beside it. */
  async function setup() {
    const [owner, admin, editor, viewer, guest, outsider] = await Promise.all(
      ['owner', 'admin', 'editor', 'viewer', 'guest', 'outsider'].map(register),
    );
    const workspace = await as(owner!).post('/workspaces').send({ name: 'Docs' }).expect(201);
    const workspaceId = workspace.body.id as string;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: admin!.id, role: 'ADMIN' },
        { workspaceId, userId: editor!.id, role: 'EDITOR' },
        { workspaceId, userId: viewer!.id, role: 'VIEWER' },
      ],
    });
    return {
      owner: owner!,
      admin: admin!,
      editor: editor!,
      viewer: viewer!,
      guest: guest!,
      outsider: outsider!,
      workspaceId,
    };
  }

  async function createDocument(user: TestUser, workspaceId: string, title: string) {
    const created = await as(user)
      .post(`/workspaces/${workspaceId}/documents`)
      .send({ title })
      .expect(201);
    return created.body.id as string;
  }

  const paragraph = (text: string) => {
    const element = new Y.XmlElement('paragraph');
    const node = new Y.XmlText();
    element.insert(0, [node]);
    node.insert(0, text);
    return element;
  };

  /** Replaces the text of a document the way a flush of the collab service does: stored, revision bumped, event. */
  async function edit(documentId: string, ...lines: string[]): Promise<number> {
    let doc = drafts.get(documentId);
    if (!doc) drafts.set(documentId, (doc = new Y.Doc()));
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      const fragment = (doc as Y.Doc).getXmlFragment('content');
      fragment.delete(0, fragment.length);
      fragment.insert(
        0,
        lines.map((line) => paragraph(line)),
      );
    });
    const { revision } = await writer.append(documentId, Y.encodeStateAsUpdate(doc, before));
    await emitDocumentChanged(queues, { documentId, revision, reason: 'content' });
    return revision;
  }

  async function find(
    user: TestUser,
    workspaceId: string,
    q: string,
    extra = '',
  ): Promise<SearchPage> {
    const response = await as(user)
      .get(`/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}${extra}`)
      .expect(200);
    return response.body as SearchPage;
  }

  const idsFor = async (user: TestUser, workspaceId: string, q: string) =>
    (await find(user, workspaceId, q)).items.map((item) => item.id);

  /** Waits for the next run of the index job, however it comes about. */
  const indexedRevision = async (documentId: string) => {
    const row = await prisma.documentSearch.findUnique({ where: { documentId } });
    return row ? Number(row.indexedRevision) : null;
  };

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    app = await createTestApp([], [SearchWorkerModule]);
    prisma = app.get(PrismaService, { strict: false });
    writer = new DocumentStateWriter(prisma);
    reader = app.get(DocumentStateReader, { strict: false });
    indexer = app.get(SearchIndexService, { strict: false });
    queues = app.get(QueueService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('indexing', () => {
    it('shows a change in the results only after the queued job has run', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Roadmap');

      // the request that created it did not index anything
      expect(await idsFor(owner, workspaceId, 'roadmap')).toEqual([]);
      expect(await indexedRevision(documentId)).toBeNull();
      await until(async () => (await idsFor(owner, workspaceId, 'roadmap')).length === 1);

      await edit(documentId, 'Ship the zebrafish prototype');
      expect(await idsFor(owner, workspaceId, 'zebrafish')).toEqual([]);
      await until(async () => (await idsFor(owner, workspaceId, 'zebrafish')).length === 1);

      const [hit] = (await find(owner, workspaceId, 'zebrafish')).items;
      expect(hit).toMatchObject({ id: documentId, title: 'Roadmap' });
      expect(textOf(hit!.snippet)).toContain('Ship the zebrafish prototype');
      expect(matchesOf(hit!.snippet)).toEqual(['zebrafish']);
      expect(new Date(hit!.updatedAt).getTime()).not.toBeNaN();
    });

    it('finds a renamed document by its new title, and no longer by the old one', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Quokka notes');
      await until(async () => (await idsFor(owner, workspaceId, 'quokka')).length === 1);

      await as(owner).patch(`/documents/${documentId}`).send({ title: 'Wombat notes' }).expect(200);
      // the title shown is always the current one; what is searched follows the job
      await until(async () => (await idsFor(owner, workspaceId, 'wombat')).length === 1);
      expect(await idsFor(owner, workspaceId, 'quokka')).toEqual([]);
      expect((await find(owner, workspaceId, 'wombat')).items[0]!.title).toBe('Wombat notes');
    });

    it('weighs the title above the body', async () => {
      const { owner, workspaceId } = await setup();
      const inBody = await createDocument(owner, workspaceId, 'Meeting');
      const inTitle = await createDocument(owner, workspaceId, 'Marmalade');
      await edit(inBody, 'We talked about marmalade for an hour');
      await until(async () => (await idsFor(owner, workspaceId, 'marmalade')).length === 2);
      expect(await idsFor(owner, workspaceId, 'marmalade')).toEqual([inTitle, inBody]);
    });

    it('requires every word and matches prefixes', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Planning');
      await edit(documentId, 'Quarterly budget review');
      await until(async () => (await idsFor(owner, workspaceId, 'quarterly')).length === 1);

      expect(await idsFor(owner, workspaceId, 'quart bud')).toEqual([documentId]);
      expect(await idsFor(owner, workspaceId, 'quarterly yearly')).toEqual([]);
      expect(await idsFor(owner, workspaceId, 'arterly')).toEqual([]);
    });

    it('ignores case and accents in both directions', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Café Zürich');
      await edit(documentId, 'Un déjà-vu à la Straße', 'Plain cafe too');
      await until(async () => (await idsFor(owner, workspaceId, 'zurich')).length === 1);

      for (const q of ['cafe', 'CAFÉ', 'café', 'zurich', 'ZÜR', 'deja', 'strasse', 'straße']) {
        expect(await idsFor(owner, workspaceId, q)).toEqual([documentId]);
      }
      // the snippet keeps the text as written and marks the word that matched
      const [hit] = (await find(owner, workspaceId, 'deja')).items;
      expect(textOf(hit!.snippet)).toContain('déjà');
      expect(matchesOf(hit!.snippet).join(' ')).toContain('déjà');
    });

    it('treats Cyrillic: case-insensitive, prefix, and ё folds to е (й and ї are different letters)', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Їжак у тумані');
      await edit(documentId, 'Йшов Ёжик додому, а ЇЖАК ще ні');
      await until(async () => (await idsFor(owner, workspaceId, 'їжак')).length === 1);

      expect(await idsFor(owner, workspaceId, 'ЇЖАК')).toEqual([documentId]);
      expect(await idsFor(owner, workspaceId, 'тум')).toEqual([documentId]);
      expect(await idsFor(owner, workspaceId, 'ежик')).toEqual([documentId]); // ё → е
      expect(await idsFor(owner, workspaceId, 'йшов')).toEqual([documentId]);
      // without the diacritic of the letter it is another word
      expect(await idsFor(owner, workspaceId, 'ижак')).toEqual([]);
      expect(await idsFor(owner, workspaceId, 'ішов')).toEqual([]);
    });

    it('finds and shows text in angle brackets, which Postgres would read as a tag', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Markup <section> notes');
      await edit(documentId, 'Wrap it in <div class="x"> and <script>alert(1)</script> stays text');
      await until(async () => (await idsFor(owner, workspaceId, 'div')).length === 1);

      expect(await idsFor(owner, workspaceId, 'script')).toEqual([documentId]);
      expect(await idsFor(owner, workspaceId, 'section')).toEqual([documentId]);
      const [hit] = (await find(owner, workspaceId, 'div')).items;
      expect(hit!.title).toBe('Markup <section> notes');
      expect(textOf(hit!.snippet)).toBe(
        'Wrap it in <div class="x"> and <script>alert(1)</script> stays text',
      );
      expect(matchesOf(hit!.snippet)).toEqual(['div']);
      expect(textOf(hit!.snippet)).not.toMatch(/\p{Cc}/u);
    });

    it('does not fail on text that cannot be stored or indexed as it is', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Hostile title\u0001');
      await edit(
        documentId,
        'before\u0000after \u0001marker\u0002 end',
        'x '.repeat(MAX_INDEXED_BODY_CHARS),
      );
      await until(async () => (await idsFor(owner, workspaceId, 'hostile')).length === 1);

      const [hit] = (await find(owner, workspaceId, 'before')).items;
      expect(hit).toBeDefined();
      // control characters never reach the snippet, so they cannot pose as the delimiters of a match
      expect(textOf(hit!.snippet)).not.toMatch(/\p{Cc}/u);
      expect(matchesOf(hit!.snippet)).toEqual(['beforeafter']);
      const row = await prisma.documentSearch.findUniqueOrThrow({ where: { documentId } });
      expect(row.body.length).toBeLessThanOrEqual(MAX_INDEXED_BODY_CHARS);
    });

    it('indexes the last state after a series of 20 changes, one of which lands while a job is running', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Series');
      await until(async () => (await indexedRevision(documentId)) !== null);

      // The first run reads the state of change 1 and then stalls; changes 2..20 are stored meanwhile.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let stalled = false;
      const original = reader.readDoc.bind(reader);
      jest.spyOn(reader, 'readDoc').mockImplementation(async (id) => {
        const doc = await original(id);
        if (!stalled) {
          stalled = true;
          await gate;
        }
        return doc;
      });

      await edit(documentId, 'version 1 alpha');
      await until(() => stalled);
      for (let version = 2; version <= 20; version += 1) {
        await edit(documentId, `version ${version} ${version === 20 ? 'omega' : 'alpha'}`);
      }
      release();

      await until(
        async () => (await indexedRevision(documentId)) === (await currentRevision(documentId)),
      );
      const row = await prisma.documentSearch.findUniqueOrThrow({ where: { documentId } });
      expect(row.body).toBe('version 20 omega');
      expect(Number(row.indexedRevision)).toBe(await currentRevision(documentId));
      expect(await idsFor(owner, workspaceId, 'omega')).toEqual([documentId]);
    });

    it('keeps the newest row when a job runs twice or a late one arrives', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Idempotent');
      await edit(documentId, 'first draft');
      await until(
        async () => (await indexedRevision(documentId)) === (await currentRevision(documentId)),
      );

      // a duplicate does nothing
      expect(await indexer.index(documentId)).toBe('unchanged');

      // a row stamped with a newer revision than the document has (a late job of an older run changes nothing)
      await prisma.$executeRaw(Prisma.sql`
        UPDATE document_search SET body = 'newer body', indexed_revision = 1000 WHERE document_id = ${documentId}::uuid`);
      expect(await indexer.index(documentId)).toBe('unchanged');
      const row = await prisma.documentSearch.findUniqueOrThrow({ where: { documentId } });
      expect(row.body).toBe('newer body');
      expect(Number(row.indexedRevision)).toBe(1000);

      // reindexing is the explicit way to rewrite it
      expect(await indexer.index(documentId, { force: true })).toBe('unchanged');
      await prisma.$executeRaw(Prisma.sql`
        UPDATE document_search SET indexed_revision = ${await currentRevision(documentId)} WHERE document_id = ${documentId}::uuid`);
      expect(await indexer.index(documentId, { force: true })).toBe('indexed');
      expect((await prisma.documentSearch.findUniqueOrThrow({ where: { documentId } })).body).toBe(
        'first draft',
      );
    });

    it('removes the row of a deleted document and brings it back on restore', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Ephemeral');
      await until(async () => (await idsFor(owner, workspaceId, 'ephemeral')).length === 1);

      await as(owner).delete(`/documents/${documentId}`).expect(204);
      // hidden at once, whatever the index says
      expect(await idsFor(owner, workspaceId, 'ephemeral')).toEqual([]);
      expect(await indexedRevision(documentId)).not.toBeNull();
      await until(async () => (await indexedRevision(documentId)) === null);

      await as(owner).post(`/documents/${documentId}/restore`).expect(200);
      await until(async () => (await idsFor(owner, workspaceId, 'ephemeral')).length === 1);
    });

    it('rebuilds a workspace from the stored documents', async () => {
      const { owner, workspaceId } = await setup();
      const kept = await createDocument(owner, workspaceId, 'Rebuilt kept');
      const gone = await createDocument(owner, workspaceId, 'Rebuilt gone');
      await edit(kept, 'content survives');
      await until(async () => (await indexedRevision(kept)) === (await currentRevision(kept)));
      await until(async () => (await indexedRevision(gone)) !== null);
      await as(owner).delete(`/documents/${gone}`).expect(204);

      await prisma.documentSearch.deleteMany({ where: { workspaceId } });
      await prisma.documentSearch.create({
        data: { documentId: gone, workspaceId, title: 'stale', body: 'stale', indexedRevision: 1 },
      });
      const summary = await indexer.reindex({ workspaceId });

      expect(summary).toEqual({ documents: 2, indexed: 1, removed: 1 });
      expect(await indexedRevision(gone)).toBeNull();
      expect(await idsFor(owner, workspaceId, 'survives')).toEqual([kept]);
    });
  });

  describe('metrics', () => {
    it('reports the documents the index has not caught up with', async () => {
      const { owner, workspaceId } = await setup();
      const registry = app.get(MetricsService, { strict: false }).registry;
      const read = async (name: string) =>
        (await registry.getSingleMetric(name)!.get()).values[0]?.value as number;

      const documentId = await createDocument(owner, workspaceId, 'Lagging');
      // the table is shared with other suites, so only "at least this one" can be said
      expect(await read('search_index_pending_documents')).toBeGreaterThanOrEqual(1);
      expect(await read('search_index_lag_seconds')).toBeGreaterThan(0);

      await until(async () => (await indexedRevision(documentId)) !== null);
      const pending = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
        SELECT count(*) AS n FROM documents d LEFT JOIN document_search s ON s.document_id = d.id
        WHERE d.id = ${documentId}::uuid AND (s.document_id IS NULL OR s.indexed_revision < d.revision)`);
      expect(Number(pending[0]!.n)).toBe(0);
    });
  });

  async function currentRevision(documentId: string): Promise<number> {
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { revision: true },
    });
    return Number(row.revision);
  }

  describe('permissions', () => {
    async function seeded() {
      const world = await setup();
      const { owner, workspaceId } = world;
      const open = await createDocument(owner, workspaceId, 'Pelican open');
      const secret = await createDocument(owner, workspaceId, 'Pelican secret');
      await as(owner).patch(`/documents/${secret}`).send({ visibility: 'RESTRICTED' }).expect(200);
      await Promise.all([edit(open, 'pelican body'), edit(secret, 'pelican body')]);
      await until(
        async () =>
          (await indexedRevision(open)) === (await currentRevision(open)) &&
          (await indexedRevision(secret)) === (await currentRevision(secret)),
      );
      return { ...world, open, secret };
    }

    it('shows members what the access rules allow, and nothing else', async () => {
      const { owner, admin, editor, viewer, workspaceId, open, secret } = await seeded();
      for (const user of [owner, admin]) {
        expect((await idsFor(user, workspaceId, 'pelican')).sort()).toEqual([open, secret].sort());
      }
      for (const user of [editor, viewer]) {
        expect(await idsFor(user, workspaceId, 'pelican')).toEqual([open]);
      }
    });

    it('finds a restricted document for the editor who wrote it, for nobody else', async () => {
      const { editor, workspaceId } = await setup();
      const own = await createDocument(editor, workspaceId, 'Pelican authored');
      await as(editor).patch(`/documents/${own}`).send({ visibility: 'RESTRICTED' }).expect(200);
      await edit(own, 'pelican body');
      await until(async () => (await indexedRevision(own)) === (await currentRevision(own)));

      expect(await idsFor(editor, workspaceId, 'pelican')).toEqual([own]);

      const second = await register('editor2');
      await prisma.workspaceMember.create({
        data: { workspaceId, userId: second.id, role: 'EDITOR' },
      });
      expect(await idsFor(second, workspaceId, 'pelican')).toEqual([]);
    });

    it('answers 404 to people outside the workspace, guests with a share included', async () => {
      const { owner, guest, outsider, workspaceId, open } = await seeded();
      await as(owner)
        .post(`/documents/${open}/shares`)
        .send({ email: guest.email, role: 'VIEWER' })
        .expect(201);
      for (const user of [guest, outsider]) {
        await as(user).get(`/workspaces/${workspaceId}/search?q=pelican`).expect(404);
      }
      await as(null).get(`/workspaces/${workspaceId}/search?q=pelican`).expect(401);
    });

    it('applies a share, and its removal, to the very next request', async () => {
      const { owner, viewer, workspaceId, secret } = await seeded();
      expect(await idsFor(viewer, workspaceId, 'secret')).toEqual([]);

      await as(owner)
        .post(`/documents/${secret}/shares`)
        .send({ email: viewer.email, role: 'VIEWER' })
        .expect(201);
      expect(await idsFor(viewer, workspaceId, 'secret')).toEqual([secret]);

      await as(owner).delete(`/documents/${secret}/shares/${viewer.id}`).expect(204);
      expect(await idsFor(viewer, workspaceId, 'secret')).toEqual([]);
    });

    it('applies a change of visibility at once', async () => {
      const { owner, editor, workspaceId, open, secret } = await seeded();
      await as(owner).patch(`/documents/${open}`).send({ visibility: 'RESTRICTED' }).expect(200);
      expect(await idsFor(editor, workspaceId, 'pelican')).toEqual([]);
      await as(owner).patch(`/documents/${secret}`).send({ visibility: 'WORKSPACE' }).expect(200);
      expect(await idsFor(editor, workspaceId, 'pelican')).toEqual([secret]);
    });

    it('stops showing a member who left, and a document that was deleted', async () => {
      const { owner, editor, workspaceId, open } = await seeded();
      await as(owner).delete(`/documents/${open}`).expect(204);
      expect(await idsFor(editor, workspaceId, 'pelican')).toEqual([]);

      await as(owner).delete(`/workspaces/${workspaceId}/members/${editor.id}`).expect(204);
      await as(editor).get(`/workspaces/${workspaceId}/search?q=pelican`).expect(404);
    });

    it('never mixes workspaces', async () => {
      const first = await seeded();
      const second = await setup();
      const other = await createDocument(second.owner, second.workspaceId, 'Pelican elsewhere');
      await until(async () => (await indexedRevision(other)) !== null);

      expect(await idsFor(first.owner, first.workspaceId, 'pelican')).not.toContain(other);
      expect(await idsFor(second.owner, second.workspaceId, 'pelican')).toEqual([other]);
      // a member of one workspace asking for another one's id
      await as(first.owner).get(`/workspaces/${second.workspaceId}/search?q=pelican`).expect(404);
    });
  });

  describe('query', () => {
    it('is safe against input meant for SQL or for the tsquery syntax', async () => {
      const { owner, workspaceId } = await setup();
      const documentId = await createDocument(owner, workspaceId, 'Injection target');
      await until(async () => (await idsFor(owner, workspaceId, 'injection')).length === 1);

      for (const q of [
        "'; DROP TABLE documents; --",
        "injection' OR '1'='1",
        '&|!<->:*()\\',
        'injection & !target | (x',
        'injection:*',
        '\u0000',
        '%',
        'a'.repeat(200),
        '"',
      ]) {
        const response = await as(owner)
          .get(`/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`)
          .expect(200);
        expect(Array.isArray(response.body.items)).toBe(true);
      }
      expect(await prisma.document.count({ where: { id: documentId } })).toBe(1);
      // the words of a hostile query are still words
      expect(await idsFor(owner, workspaceId, 'injection & !target | (x')).toEqual([]);
      expect(await idsFor(owner, workspaceId, 'injection & !target')).toEqual([documentId]);
    });

    it('returns an empty page for an empty query and validates the parameters', async () => {
      const { owner, workspaceId } = await setup();
      for (const path of ['', '?q=', '?q=%20%20', '?q=%26%7C%21']) {
        const response = await as(owner)
          .get(`/workspaces/${workspaceId}/search${path}`)
          .expect(200);
        expect(response.body).toEqual({ items: [], nextCursor: null });
      }
      for (const path of [
        `?q=${'a'.repeat(201)}`,
        '?q=a&limit=0',
        '?q=a&limit=51',
        '?q=a&limit=x',
        '?q=a&cursor=nonsense',
      ]) {
        const response = await as(owner)
          .get(`/workspaces/${workspaceId}/search${path}`)
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }
      // like every workspace route, an id that is not a uuid is a workspace that is not there
      await as(owner).get('/workspaces/not-a-uuid/search?q=a').expect(404);
      await as(owner).get(`/workspaces/${UNKNOWN_ID}/search?q=a`).expect(404);
    });

    it('pages through the results with a cursor, best match first, without repeats or gaps', async () => {
      const { owner, workspaceId } = await setup();
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1)
        ids.push(await createDocument(owner, workspaceId, `Paging ${i}`));
      await until(async () => (await idsFor(owner, workspaceId, 'paging')).length === 7);

      const everything = await idsFor(owner, workspaceId, 'paging');
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: SearchPage = await find(
          owner,
          workspaceId,
          'paging',
          `&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(5);
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(everything);
      expect(new Set(seen).size).toBe(7);
    });

    it('limits how often a user can search', async () => {
      const { owner, workspaceId } = await setup();
      for (let i = 0; i < 40; i += 1) {
        await as(owner).get(`/workspaces/${workspaceId}/search?q=rate`).expect(200);
      }
      const limited = await as(owner).get(`/workspaces/${workspaceId}/search?q=rate`).expect(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
    });
  });
});
