import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@collab-docs/db';
import type { Access, WorkspaceRole } from '@collab-docs/shared';
import { confirmEmail } from '../test/confirm-email';

const PASSWORD = 'correct-horse-battery';
export const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';
/** A well-formed edit token that belongs to no link. */
export const UNKNOWN_TOKEN = 'A'.repeat(43);

/**
 * Everyone who can knock on the api. `anon` holds no session at all; `guestLink` and `expiredLink` carry a public
 * link instead (a VIEW slug and an EDIT token), which only the `/public` routes look at; the others are signed in.
 */
export const PERSONAS = [
  'anon',
  'outsider',
  'viewer',
  'editor',
  'admin',
  'owner',
  'guest',
  'guestLink',
  'expiredLink',
] as const;
export type PersonaName = (typeof PERSONAS)[number];

export const VARIANTS = ['open', 'restricted'] as const;
/** `open`: visible to the whole workspace. `restricted`: only the people it was shared with and the admins. */
export type Variant = (typeof VARIANTS)[number];

export interface Persona {
  name: PersonaName;
  /** Access token; absent for the personas that arrive without a session. */
  token?: string;
  id?: string;
  email?: string;
}

interface LinkSet {
  documentId: string;
  slug: string;
  editToken: string;
}

/** Workspace role of a persona; guests and outsiders are no members. */
export const WORKSPACE_ROLE: Partial<Record<PersonaName, WorkspaceRole>> = {
  viewer: 'VIEWER',
  editor: 'EDITOR',
  admin: 'ADMIN',
  owner: 'OWNER',
};

/** What the permission model (spec §4) grants each persona on a document of each variant. */
export const DOCUMENT_ACCESS: Record<Variant, Partial<Record<PersonaName, Access>>> = {
  open: {
    outsider: 'NONE',
    viewer: 'VIEW',
    editor: 'EDIT',
    admin: 'MANAGE',
    owner: 'MANAGE',
    guest: 'EDIT',
  },
  restricted: {
    outsider: 'NONE',
    viewer: 'NONE',
    editor: 'NONE',
    admin: 'MANAGE',
    owner: 'MANAGE',
    guest: 'EDIT',
  },
};

export const HAS_SESSION = (name: PersonaName): boolean =>
  !['anon', 'guestLink', 'expiredLink'].includes(name);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

let counter = 0;

/** One workspace with every role in it, and the documents, links and neighbours the matrix aims at. */
export class Fixture {
  readonly personas = {} as Record<PersonaName, Persona>;
  workspaceId = '';
  readonly documents = {} as Record<Variant, string>;
  /** A document with live VIEW and EDIT links. */
  live!: LinkSet;
  /** A document whose VIEW and EDIT links have expired. */
  expired!: LinkSet;
  /** A user nobody else knows, to be shared with and invited. */
  spare!: TestUser;

  private constructor(
    readonly app: NestExpressApplication,
    readonly prisma: PrismaClient,
  ) {}

  static async create(app: NestExpressApplication, prisma: PrismaClient): Promise<Fixture> {
    const fixture = new Fixture(app, prisma);
    await fixture.build();
    return fixture;
  }

  http() {
    return request(this.app.getHttpServer());
  }

  /** A request from an address of its own, so that no per-address limit gets in the way. */
  call(method: 'get' | 'post' | 'patch' | 'delete', path: string, token?: string) {
    counter += 1;
    const agent = this.http();
    const req = agent[method](path).set(
      'X-Forwarded-For',
      `10.2.${counter % 250}.${(counter >> 8) % 250}`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async register(label: string): Promise<TestUser> {
    counter += 1;
    const email = `${label}-${Date.now()}-${counter}@security-test.example`;
    const response = await this.call('post', '/api/auth/register')
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    await confirmEmail(this.prisma, response.body.user.id);
    return { id: response.body.user.id, email, token: response.body.accessToken };
  }

  async createDocument(token: string, workspaceId: string, variant: Variant, title = 'Doc') {
    const created = await this.call('post', `/api/workspaces/${workspaceId}/documents`, token)
      .send({ title })
      .expect(201);
    const id = created.body.id as string;
    if (variant === 'restricted') {
      await this.call('patch', `/api/documents/${id}`, token)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
    }
    return id;
  }

  async share(ownerToken: string, documentId: string, email: string, role: 'VIEWER' | 'EDITOR') {
    await this.call('post', `/api/documents/${documentId}/shares`, ownerToken)
      .send({ email, role })
      .expect(201);
  }

  /** Publishes both links of a document and returns what a visitor would be handed. */
  async publish(ownerToken: string, documentId: string): Promise<LinkSet> {
    const view = await this.call('post', `/api/documents/${documentId}/public-links`, ownerToken)
      .send({ mode: 'VIEW' })
      .expect(201);
    const edit = await this.call('post', `/api/documents/${documentId}/public-links`, ownerToken)
      .send({ mode: 'EDIT' })
      .expect(201);
    return { documentId, slug: view.body.slug as string, editToken: edit.body.token as string };
  }

  private async build() {
    const [owner, admin, editor, viewer, outsider, guest, spare] = await Promise.all(
      ['owner', 'admin', 'editor', 'viewer', 'outsider', 'guest', 'spare'].map((l) =>
        this.register(l),
      ),
    );
    this.spare = spare!;
    const named = { owner, admin, editor, viewer, outsider, guest } as const;
    this.personas.anon = { name: 'anon' };
    for (const [name, user] of Object.entries(named)) {
      this.personas[name as PersonaName] = {
        name: name as PersonaName,
        id: user!.id,
        email: user!.email,
        token: user!.token,
      };
    }

    const workspace = await this.call('post', '/api/workspaces', owner!.token)
      .send({ name: 'Security' })
      .expect(201);
    this.workspaceId = workspace.body.id as string;
    await this.prisma.subscription.update({
      where: { workspaceId: this.workspaceId },
      data: { plan: 'TEAM' },
    });
    await this.prisma.workspaceMember.createMany({
      data: [
        { workspaceId: this.workspaceId, userId: admin!.id, role: 'ADMIN' },
        { workspaceId: this.workspaceId, userId: editor!.id, role: 'EDITOR' },
        { workspaceId: this.workspaceId, userId: viewer!.id, role: 'VIEWER' },
      ],
    });

    for (const variant of VARIANTS) {
      const id = await this.createDocument(owner!.token, this.workspaceId, variant);
      await this.share(owner!.token, id, guest!.email, 'EDITOR');
      this.documents[variant] = id;
    }

    const liveId = await this.createDocument(owner!.token, this.workspaceId, 'open', 'Live');
    this.live = await this.publish(owner!.token, liveId);
    const expiredId = await this.createDocument(owner!.token, this.workspaceId, 'open', 'Expired');
    this.expired = await this.publish(owner!.token, expiredId);
    await this.prisma.publicLink.updateMany({
      where: { documentId: expiredId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    this.personas.guestLink = { name: 'guestLink' };
    this.personas.expiredLink = { name: 'expiredLink' };
  }

  get owner(): Persona {
    return this.personas.owner;
  }
}

/**
 * Things the routes aim at, made when a row asks for them. Anything a request may change or destroy comes fresh
 * (`fresh`, `thread`, `member`...), so that one persona's allowed call never alters what the next one sees.
 */
export class Resources {
  constructor(
    private readonly f: Fixture,
    readonly variant: Variant,
  ) {}

  get workspaceId(): string {
    return this.f.workspaceId;
  }

  /** The shared document of this variant. */
  get document(): string {
    return this.f.documents[this.variant];
  }

  private get ownerToken(): string {
    return this.f.owner.token as string;
  }

  /** A document of this variant that is shared with the guest, like the shared one. */
  async fresh(): Promise<string> {
    const id = await this.f.createDocument(this.ownerToken, this.workspaceId, this.variant);
    await this.f.share(this.ownerToken, id, this.f.personas.guest.email as string, 'EDITOR');
    return id;
  }

  /** A fresh document that is in the trash. */
  async deleted(): Promise<string> {
    const id = await this.fresh();
    await this.f.call('delete', `/api/documents/${id}`, this.ownerToken).expect(204);
    return id;
  }

  async thread(
    documentId?: string,
  ): Promise<{ documentId: string; threadId: string; commentId: string }> {
    const docId = documentId ?? (await this.fresh());
    const created = await this.f
      .call('post', `/api/documents/${docId}/threads`, this.ownerToken)
      .send({ blockId: 'block-1', body: 'A remark' })
      .expect(201);
    return {
      documentId: docId,
      threadId: created.body.thread.id as string,
      commentId: created.body.thread.comments[0].id as string,
    };
  }

  /** A document with a thread whose first comment was written by `author`. */
  async threadBy(author: Persona): Promise<{ threadId: string; commentId: string }> {
    const documentId = await this.fresh();
    const created = await this.f
      .call('post', `/api/documents/${documentId}/threads`, author.token ?? this.ownerToken)
      .send({ blockId: 'block-1', body: 'A remark' })
      .expect(201);
    return {
      threadId: created.body.thread.id as string,
      commentId: created.body.thread.comments[0].id as string,
    };
  }

  async version(documentId?: string): Promise<{ documentId: string; versionId: string }> {
    const docId = documentId ?? (await this.fresh());
    const row = await this.f.prisma.documentVersion.create({
      data: { documentId: docId, state: Buffer.from([0, 0]), kind: 'MANUAL', title: 'Doc' },
    });
    return { documentId: docId, versionId: row.id };
  }

  async attachment(
    status: 'READY' | 'PENDING' = 'READY',
  ): Promise<{ documentId: string; attachmentId: string }> {
    const documentId = await this.fresh();
    const id = crypto.randomUUID();
    const row = await this.f.prisma.attachment.create({
      data: {
        id,
        workspaceId: this.workspaceId,
        documentId,
        key: `ws/${this.workspaceId}/doc/${documentId}/${id}`,
        size: 10,
        mime: 'image/png',
        status,
        uploadedBy: this.f.owner.id as string,
      },
    });
    return { documentId, attachmentId: row.id };
  }

  /** A fresh document with a link of each kind. */
  async linked(): Promise<{ documentId: string; linkId: string }> {
    const documentId = await this.fresh();
    const created = await this.f
      .call('post', `/api/documents/${documentId}/public-links`, this.ownerToken)
      .send({ mode: 'VIEW' })
      .expect(201);
    return { documentId, linkId: created.body.id as string };
  }

  /** A fresh document shared with the spare user. */
  async sharedWithSpare(): Promise<{ documentId: string; userId: string }> {
    const documentId = await this.fresh();
    await this.f.share(this.ownerToken, documentId, this.f.spare.email, 'VIEWER');
    return { documentId, userId: this.f.spare.id };
  }

  /** A new workspace member (an editor) that the call may promote or remove. */
  async member(): Promise<string> {
    const user = await this.f.register('member');
    await this.f.prisma.workspaceMember.create({
      data: { workspaceId: this.workspaceId, userId: user.id, role: 'EDITOR' },
    });
    return user.id;
  }

  async invite(): Promise<string> {
    const created = await this.f
      .call('post', `/api/workspaces/${this.workspaceId}/invites`, this.ownerToken)
      .send({
        email: `invitee-${Date.now()}-${Math.random().toString(36).slice(2)}@security-test.example`,
        role: 'EDITOR',
      })
      .expect(201);
    return created.body.id as string;
  }
}
