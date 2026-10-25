import * as Y from 'yjs';
import { createTestDb, makeDocument, makeUser, makeWorkspace, type TestDb } from '../testing';
import { DocumentStateReader, DocumentStateWriter, DocumentVersions, hashUpdate } from './index';

/** A document that records every update it produces, like a client typing. */
function typist() {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const text = new Y.XmlText();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [text]);
  doc.getXmlFragment('content').insert(0, [paragraph]);
  return {
    doc,
    updates,
    type: (value: string) => text.insert(text.length, value),
    value: () => text.toString(),
  };
}

const content = (doc: Y.Doc): string => doc.getXmlFragment('content').toString();

describe('CRDT storage', () => {
  let db: TestDb;
  let reader: DocumentStateReader;
  let writer: DocumentStateWriter;
  let versions: DocumentVersions;
  let documentId: string;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDb();
    reader = new DocumentStateReader(db.prisma);
    writer = new DocumentStateWriter(db.prisma);
    versions = new DocumentVersions(db.prisma, reader);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.truncate();
    const { workspace, owner } = await makeWorkspace(db.prisma);
    userId = owner.id;
    documentId = (await makeDocument(db.prisma, { workspaceId: workspace.id, createdBy: owner.id }))
      .id;
  });

  const rows = () => db.prisma.documentUpdate.count({ where: { documentId } });

  describe('appending and reading', () => {
    it('reads back exactly what was appended, in any number of rows', async () => {
      const source = typist();
      for (const word of ['alpha ', 'beta ', 'gamma ']) source.type(word);
      for (const update of source.updates) await writer.append(documentId, update);

      const stored = await reader.read(documentId);
      expect(stored.tailRows).toBe(source.updates.length);
      expect(stored.skippedRows).toBe(0);
      const restored = await reader.readDoc(documentId);
      expect(content(restored)).toBe(content(source.doc));
      expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(source.doc));
      expect(stored.stateVector).toEqual(Y.encodeStateVector(source.doc));
    });

    it('returns an empty result for a document without content', async () => {
      const stored = await reader.read(documentId);
      expect(stored).toMatchObject({ update: null, tailRows: 0, tailBytes: 0, skippedRows: 0 });
      expect(content(await reader.readDoc(documentId))).toBe('');
    });

    it('bumps the revision with every stored update, in the same transaction', async () => {
      const source = typist();
      source.type('x');
      const first = await writer.append(documentId, Y.mergeUpdates(source.updates));
      expect(first).toEqual({ inserted: true, revision: 1 });
      source.type('y');
      const second = await writer.append(documentId, source.updates[source.updates.length - 1]!);
      expect(second).toEqual({ inserted: true, revision: 2 });
      const document = await db.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(document.revision).toBe(2n);
      expect(document.contentUpdatedAt).not.toBeNull();
    });

    it('does not store the same bytes twice and does not bump the revision again', async () => {
      const source = typist();
      source.type('once');
      const merged = Y.mergeUpdates(source.updates);
      await writer.append(documentId, merged);
      await expect(writer.append(documentId, merged)).resolves.toEqual({
        inserted: false,
        revision: 1,
      });
      expect(await rows()).toBe(1);
      const stored = await db.prisma.documentUpdate.findFirstOrThrow({ where: { documentId } });
      expect(stored.updateHash).toBe(hashUpdate(merged));
    });

    it('rejects an update for a document that does not exist', async () => {
      const source = typist();
      source.type('x');
      await expect(
        writer.append('0198d6c0-0000-7000-8000-000000000000', source.updates[0]!),
      ).rejects.toThrow();
    });
  });

  describe('compaction', () => {
    async function fill(count: number) {
      const source = typist();
      await writer.append(documentId, Y.mergeUpdates(source.updates));
      source.updates.length = 0;
      for (let i = 0; i < count; i += 1) {
        source.type(`w${i} `);
        await writer.append(documentId, source.updates.pop()!);
      }
      return source;
    }

    it('folds the log into the state without changing the content', async () => {
      const source = await fill(40);
      expect(await rows()).toBe(41);
      const before = await reader.read(documentId);

      await expect(writer.compact(documentId)).resolves.toEqual({ folded: 41, skipped: 0 });

      expect(await rows()).toBe(0);
      const after = await reader.read(documentId);
      expect(after.tailRows).toBe(0);
      expect(after.stateVector).toEqual(before.stateVector);
      expect(content(await reader.readDoc(documentId))).toBe(content(source.doc));
    });

    it('keeps appending after a compaction and reads state + new tail', async () => {
      const source = await fill(5);
      await writer.compact(documentId);
      source.type('after ');
      await writer.append(documentId, source.updates.pop()!);
      expect((await reader.read(documentId)).tailRows).toBe(1);
      expect(content(await reader.readDoc(documentId))).toBe(content(source.doc));
    });

    it('is a no-op when there is nothing to fold', async () => {
      await fill(3);
      await writer.compact(documentId);
      await expect(writer.compact(documentId)).resolves.toEqual({ folded: 0, skipped: 0 });
    });

    it('survives concurrent compactions', async () => {
      const source = await fill(30);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => writer.compact(documentId)),
      );
      expect(results.reduce((total, r) => total + r.folded, 0)).toBe(31);
      expect(await rows()).toBe(0);
      expect(content(await reader.readDoc(documentId))).toBe(content(source.doc));
    });

    it('loses no update when appends and compactions race', async () => {
      const source = typist();
      await writer.append(documentId, Y.mergeUpdates(source.updates));
      source.updates.length = 0;
      const appends: Promise<unknown>[] = [];
      const compactions: Promise<unknown>[] = [];
      for (let i = 0; i < 60; i += 1) {
        source.type(`${i},`);
        appends.push(writer.append(documentId, source.updates.pop()!));
        if (i % 6 === 0) compactions.push(writer.compact(documentId));
      }
      await Promise.all([...appends, ...compactions]);
      const stored = await reader.readDoc(documentId);
      expect(content(stored)).toBe(content(source.doc));
      expect(Y.encodeStateVector(stored)).toEqual(Y.encodeStateVector(source.doc));
    });
  });

  describe('damaged log rows', () => {
    it('skips a row that cannot be decoded and reports it', async () => {
      const source = typist();
      source.type('good ');
      await writer.append(documentId, Y.mergeUpdates(source.updates));
      source.updates.length = 0;
      await db.prisma.documentUpdate.create({
        data: { documentId, update: Buffer.from([255, 255, 255, 9, 9]), updateHash: 'broken' },
      });
      source.type('later');
      await writer.append(documentId, source.updates.pop()!);

      const stored = await reader.read(documentId);
      expect(stored.skippedRows).toBe(1);
      expect(stored.tailRows).toBe(3);
      expect(content(await reader.readDoc(documentId))).toBe(content(source.doc));

      await expect(writer.compact(documentId)).resolves.toMatchObject({ folded: 3, skipped: 1 });
      expect((await reader.read(documentId)).skippedRows).toBe(0);
      expect(content(await reader.readDoc(documentId))).toBe(content(source.doc));
    });
  });

  describe('versions', () => {
    it('snapshots the stored content with the title and the author', async () => {
      const source = typist();
      source.type('v1');
      await writer.append(documentId, Y.mergeUpdates(source.updates));
      await db.prisma.document.update({ where: { id: documentId }, data: { title: 'Plan' } });

      const info = await versions.create({
        documentId,
        kind: 'MANUAL',
        label: 'first',
        createdBy: userId,
      });
      expect(info).toMatchObject({
        kind: 'MANUAL',
        label: 'first',
        title: 'Plan',
        createdBy: userId,
      });

      source.type(' and more');
      await writer.append(documentId, source.updates[source.updates.length - 1]!);
      const snapshot = await versions.readDoc(documentId, info.id);
      expect(content(snapshot!)).toContain('v1');
      expect(content(snapshot!)).not.toContain('and more');
    });

    it('snapshots an empty document and refuses a version of another document', async () => {
      const empty = await versions.create({ documentId, kind: 'AUTO' });
      expect(content((await versions.readDoc(documentId, empty.id))!)).toBe('');
      expect(empty.createdBy).toBeNull();
      const { workspace, owner } = await makeWorkspace(db.prisma);
      const other = await makeDocument(db.prisma, {
        workspaceId: workspace.id,
        createdBy: owner.id,
      });
      await expect(versions.readDoc(other.id, empty.id)).resolves.toBeNull();
    });

    it('prunes automatic snapshots beyond the limit and keeps manual ones', async () => {
      const make = async (kind: 'AUTO' | 'MANUAL' | 'PRE_RESTORE', count: number) => {
        for (let i = 0; i < count; i += 1) await versions.create({ documentId, kind });
      };
      await make('MANUAL', 3);
      await make('AUTO', 8);
      await make('PRE_RESTORE', 2);

      await expect(versions.prune({ maxAuto: 5 })).resolves.toBe(3);
      const left = await db.prisma.documentVersion.groupBy({
        by: ['kind'],
        where: { documentId },
        _count: true,
      });
      expect(Object.fromEntries(left.map((g) => [g.kind, g._count]))).toEqual({
        MANUAL: 3,
        AUTO: 5,
        PRE_RESTORE: 2,
      });
    });

    it('drops the oldest non-manual snapshots first when the total cap is exceeded', async () => {
      for (let i = 0; i < 6; i += 1) await versions.create({ documentId, kind: 'AUTO' });
      for (let i = 0; i < 4; i += 1) await versions.create({ documentId, kind: 'MANUAL' });
      await versions.prune({ maxAuto: 50, maxTotal: 7 });
      const kinds = await db.prisma.documentVersion.groupBy({
        by: ['kind'],
        where: { documentId },
        _count: true,
      });
      const counts = Object.fromEntries(kinds.map((g) => [g.kind, g._count]));
      expect(counts.MANUAL).toBe(4);
      expect(counts.AUTO).toBe(3);
    });

    it('reports when the last automatic snapshot was taken', async () => {
      await expect(versions.lastAutoAt(documentId)).resolves.toBeNull();
      const info = await versions.create({ documentId, kind: 'AUTO' });
      await expect(versions.lastAutoAt(documentId)).resolves.toEqual(info.createdAt);
      await expect(versions.countManual(documentId)).resolves.toBe(0);
    });
  });
});
