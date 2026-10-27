import '../test/security-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import * as Y from 'yjs';
import { DocumentStateWriter, type PrismaClient } from '@collab-docs/db';
import type { SearchPage } from '@collab-docs/shared';
import { MARK_NAMES, NODE_NAMES, sanitizeHref } from '@collab-docs/shared/content';
import { renderMentionEmail } from '../notifications/mention-email';
import { renderInviteEmail } from '../notifications/invite-email';
import { PrismaService } from '../prisma/prisma.service';
import { SearchIndexService } from '../search/search-index.service';
import { SearchWorkerModule } from '../search/search.module';
import { createTestApp } from '../test/test-app';
import { HOSTILE_ATTRIBUTES, HOSTILE_HREFS, HOSTILE_NODES, HOSTILE_TEXT } from './xss-corpus';

const PASSWORD = 'correct-horse-battery';

interface Owner {
  id: string;
  token: string;
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: Node[];
}

/** Every rule a rendered tree has to obey, whichever path it took to get here. */
function assertInert(tree: Node): void {
  const visit = (node: Node) => {
    expect(NODE_NAMES as readonly string[]).toContain(node.type);
    for (const mark of node.marks ?? []) {
      expect(MARK_NAMES as readonly string[]).toContain(mark.type);
      if (mark.type === 'link') {
        const href = mark.attrs?.href;
        // what the sanitiser kept must itself be what the sanitiser accepts
        expect(typeof href === 'string' && sanitizeHref(href)).toBeTruthy();
        expect(String(href)).toMatch(/^(https?:|mailto:)/i);
      }
    }
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      expect(key).not.toMatch(/^on/i);
      expect(['style', 'srcdoc', 'formaction']).not.toContain(key);
      if (typeof value === 'string') expect(value).not.toMatch(/^\s*(javascript|vbscript|data):/i);
    }
    node.content?.forEach(visit);
  };
  visit(tree);
}

/**
 * The text of a hostile paragraph may well contain `javascript:` or `onerror=`: it is text. What must not exist is
 * structure: a link whose target is hostile, or an attribute that the schema does not know.
 */
function expectNothingExecutable(tree: Node): void {
  const visit = (node: Node) => {
    expect(node.marks?.some((mark) => mark.type === 'link') ?? false).toBe(false);
    for (const key of Object.keys(node.attrs ?? {})) {
      expect(Object.keys(HOSTILE_ATTRIBUTES)).not.toContain(key);
      expect(['src']).not.toContain(key);
    }
    expect(HOSTILE_NODES as readonly string[]).not.toContain(node.type);
    node.content?.forEach(visit);
  };
  visit(tree);
}

describe('hostile content through every path that shows it to somebody else', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let writer: DocumentStateWriter;
  let indexer: SearchIndexService;
  let owner: Owner;
  let workspaceId: string;
  let documentId: string;
  let slug: string;
  let counter = 0;

  const call = (method: 'get' | 'post' | 'patch', path: string) => {
    counter += 1;
    const agent = request(app.getHttpServer());
    return agent[method](`/api${path}`).set(
      'X-Forwarded-For',
      `10.3.${counter % 250}.${(counter >> 8) % 250}`,
    );
  };
  const authed = (method: 'get' | 'post' | 'patch', path: string) =>
    call(method, path).set('Authorization', `Bearer ${owner.token}`);

  /** A body made of the whole corpus: text, links with hostile targets, nodes and attributes the schema lacks. */
  function hostileBody(marker: string): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('content');
    const paragraph = (text: string, attributes?: Record<string, unknown>) => {
      const element = new Y.XmlElement('paragraph');
      const node = new Y.XmlText();
      element.insert(0, [node]);
      node.insert(0, text, attributes);
      return element;
    };
    const nodes: Array<Y.XmlElement> = [paragraph(`${marker} findable`)];
    for (const text of HOSTILE_TEXT) nodes.push(paragraph(`${marker} ${text}`));
    for (const href of HOSTILE_HREFS) {
      nodes.push(
        paragraph(`${marker} link`, { link: { href, target: '_top', onclick: 'alert(1)' } }),
      );
    }
    for (const type of HOSTILE_NODES) {
      const element = new Y.XmlElement(type);
      element.insert(0, [new Y.XmlText(`${marker} inside ${type}`)]);
      nodes.push(element);
    }
    const image = new Y.XmlElement('image');
    image.setAttribute('src', 'javascript:alert(1)');
    for (const [key, value] of Object.entries(HOSTILE_ATTRIBUTES)) image.setAttribute(key, value);
    nodes.push(image);
    const hostileParagraph = paragraph(`${marker} attributes`);
    for (const [key, value] of Object.entries(HOSTILE_ATTRIBUTES))
      hostileParagraph.setAttribute(key, value);
    nodes.push(hostileParagraph);
    fragment.insert(0, nodes);
    return doc;
  }

  beforeAll(async () => {
    app = await createTestApp([], [SearchWorkerModule]);
    prisma = app.get(PrismaService, { strict: false });
    writer = new DocumentStateWriter(prisma);
    indexer = app.get(SearchIndexService, { strict: false });

    const registered = await call('post', '/auth/register').send({
      email: `xss-${Date.now()}@security-test.example`,
      password: PASSWORD,
      name: 'Owner',
    });
    expect(registered.status).toBe(201);
    owner = { id: registered.body.user.id, token: registered.body.accessToken };
    const workspace = await authed('post', '/workspaces').send({ name: 'Hostile' }).expect(201);
    workspaceId = workspace.body.id;
    await prisma.subscription.update({ where: { workspaceId }, data: { plan: 'TEAM' } });
    const created = await authed('post', `/workspaces/${workspaceId}/documents`)
      .send({ title: '<script>alert(1)</script> title' })
      .expect(201);
    documentId = created.body.id;

    await writer.append(documentId, Y.encodeStateAsUpdate(hostileBody('zebrafish')));
    const published = await authed('post', `/documents/${documentId}/public-links`)
      .send({ mode: 'VIEW' })
      .expect(201);
    slug = published.body.slug;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is inert on the published page', async () => {
    const response = await call('get', `/public/documents/${slug}`).expect(200);
    assertInert(response.body.content as Node);
    expectNothingExecutable(response.body.content as Node);
    // the markup that a visitor typed is still there, as text
    expect(JSON.stringify(response.body)).toContain('<script>alert(1)</script>');
  });

  it('is inert in the preview of a version', async () => {
    const state = Y.encodeStateAsUpdate(hostileBody('zebrafish'));
    const version = await prisma.documentVersion.create({
      data: { documentId, state: Buffer.from(state), kind: 'MANUAL', title: 'Hostile' },
    });
    const response = await authed('get', `/documents/${documentId}/versions/${version.id}`).expect(
      200,
    );
    assertInert(response.body.content as Node);
    expectNothingExecutable(response.body.content as Node);
  });

  it('comes back from search as plain segments, never as markup', async () => {
    await indexer.index(documentId, { force: true });
    const response = await authed(
      'get',
      `/workspaces/${workspaceId}/search?q=${encodeURIComponent('zebrafish')}`,
    ).expect(200);
    const page = response.body as SearchPage;
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(Array.isArray(item.snippet)).toBe(true);
      for (const part of item.snippet) {
        expect(Object.keys(part).sort()).toEqual(['match', 'text']);
        // the highlight delimiters of the database never reach the client
        expect([...part.text].every((char) => char.charCodeAt(0) > 2)).toBe(true);
      }
    }
  });

  it('is escaped in the emails that quote it', () => {
    const allowedTags = new Set([
      'html',
      'body',
      'p',
      'strong',
      'blockquote',
      'a',
      'br',
      'h1',
      'div',
    ]);
    for (const text of [...HOSTILE_TEXT, ...HOSTILE_HREFS]) {
      const mention = renderMentionEmail({
        actorName: text,
        documentTitle: text,
        excerpt: text,
        link: `https://app.example/w/1/d/2?x=${text}`,
      });
      const invite = renderInviteEmail({
        workspaceName: text,
        inviterName: text,
        role: 'EDITOR',
        link: `https://app.example/invite/${text}`,
        expiresAt: new Date().toISOString(),
      });
      for (const email of [mention, invite]) {
        const tags = [...email.html.matchAll(/<\/?([a-z0-9]+)/gi)].map((match) =>
          match[1]!.toLowerCase(),
        );
        expect(tags.filter((tag) => tag !== '!doctype' && !allowedTags.has(tag))).toEqual([]);
        // attributes of real tags: quoted values are skipped whole, so escaped text inside them is not mistaken
        const attributes = [...email.html.matchAll(/<[a-z][^>]*>/gi)].flatMap((tag) =>
          [...tag[0].matchAll(/\s([a-z-]+)="[^"]*"/gi)].map((match) => match[1]!.toLowerCase()),
        );
        expect(attributes.filter((name) => !['style', 'href'].includes(name))).toEqual([]);
        // the subject is a header: a line break in it would be a way to add headers
        expect(email.subject).not.toMatch(/[\r\n]/);
      }
    }
  });
});
