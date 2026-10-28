import type { APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { expect, test } from '../fixtures';
import { type LogLine, SERVICES, type Service, logsOf } from '../logs';
import { ORIGIN, createDocument, createWorkspace } from '../workspace';

const POLL = { timeout: 20_000, intervals: [500, 1000] };

/** A correlation id the suite can tell from every other request's. */
const idFor = (label: string) =>
  `e2e-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const post = (
  request: APIRequestContext,
  path: string,
  headers: Record<string, string>,
  data?: object,
) => request.post(path, { data, headers: { origin: ORIGIN, ...headers } });

test.describe('observability', () => {
  test.describe.configure({ mode: 'serial' });
  const startedAt = new Date(Date.now() - 2000);

  /** Waits for a line of `service` that satisfies `match`. */
  async function lineOf(service: Service, match: (line: LogLine) => boolean): Promise<LogLine> {
    let found: LogLine | undefined;
    await expect
      .poll(async () => {
        found = (await logsOf(service, startedAt)).lines.find(match);
        return found !== undefined;
      }, POLL)
      .toBe(true);
    return found as LogLine;
  }

  test('one correlation id follows a request from the page through the api, the queue, the worker and collab', async ({
    signedInPage: page,
  }) => {
    const request = page.request;
    const workspaceId = await createWorkspace(page, 'Tracing');
    const documentId = await createDocument(page, workspaceId, 'Traced');

    // web -> api: the page is rendered on the server, which calls the api on behalf of the visitor
    const pageId = idFor('page');
    const rendered = await request.get(`/workspaces/${workspaceId}`, {
      headers: { 'x-correlation-id': pageId },
    });
    expect(rendered.status()).toBe(200);
    expect(rendered.headers()['x-correlation-id']).toBe(pageId);
    const apiRequest = await lineOf(
      'api',
      (line) => line.correlationId === pageId && JSON.stringify(line).includes(workspaceId),
    );
    expect(apiRequest.level).toBeGreaterThan(0);

    // api -> queue -> worker: publishing asks the worker to rebuild the page, and the job keeps the id
    const jobId = idFor('job');
    const published = await post(
      request,
      `/api/documents/${documentId}/public-links`,
      { 'x-correlation-id': jobId },
      { mode: 'VIEW' },
    );
    expect(published.status()).toBe(201);
    expect(published.headers()['x-correlation-id']).toBe(jobId);
    await lineOf(
      'api',
      (line) => line.event === 'document.published' && line.correlationId === jobId,
    );
    await lineOf(
      'worker',
      (line) => line.event === 'revalidate.sent' && line.correlationId === jobId,
    );

    // api -> collab: the ticket carries the id, and the service puts it on the lines of the socket
    const socketId = idFor('socket');
    const ticketResponse = await post(request, `/api/documents/${documentId}/collab-ticket`, {
      'x-correlation-id': socketId,
    });
    expect(ticketResponse.status()).toBe(200);
    const { ticket, wsUrl } = (await ticketResponse.json()) as { ticket: string; wsUrl: string };
    const socket = new WebSocket(`${wsUrl}/${documentId}?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    try {
      await lineOf(
        'collab',
        (line) => line.event === 'collab.connected' && line.ticketCorrelationId === socketId,
      );
    } finally {
      socket.close();
    }
  });

  test('the events that matter are logged as structured lines, and no secret is logged', async ({
    signedInPage: page,
    user,
  }) => {
    const request = page.request;
    const workspaceId = await createWorkspace(page, 'Audit trail');
    const documentId = await createDocument(page, workspaceId, 'Audited');
    const started = new Date();

    // publication
    const link = await post(
      request,
      `/api/documents/${documentId}/public-links`,
      {},
      { mode: 'VIEW' },
    );
    expect(link.status()).toBe(201);
    const { id: linkId } = (await link.json()) as { id: string };
    const unpublish = await request.delete(`/api/documents/${documentId}/public-links/${linkId}`, {
      headers: { origin: ORIGIN },
    });
    expect(unpublish.status()).toBe(204);

    // a plan change, and the same event delivered again
    const checkout = await post(
      request,
      `/api/workspaces/${workspaceId}/billing/checkout`,
      {},
      { plan: 'PRO' },
    );
    expect(checkout.status()).toBe(201);
    const { sessionId } = (await checkout.json()) as { sessionId: string };
    const paid = await post(
      request,
      `/api/mock-provider/checkout-sessions/${sessionId}/complete`,
      {},
    );
    expect(paid.status()).toBe(202);
    const { eventId } = (await paid.json()) as { eventId: string };
    await lineOf(
      'worker',
      (line) => line.event === 'plan.changed' && JSON.stringify(line).includes(workspaceId),
    );
    const again = await post(request, `/api/mock-provider/events/${eventId}/redeliver`, {});
    expect(again.status()).toBe(202);

    // an update the server turns down
    const ticketResponse = await post(request, `/api/documents/${documentId}/collab-ticket`, {});
    const { ticket, wsUrl } = (await ticketResponse.json()) as { ticket: string; wsUrl: string };
    const socket = new WebSocket(`${wsUrl}/${documentId}?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    // a sync message (0) of the update kind (2) whose payload is not a Yjs update
    socket.send(Uint8Array.from([0, 2, 4, 255, 255, 255, 255]));

    const find = async (service: Service, event: string, extra?: (line: LogLine) => boolean) =>
      lineOf(service, (line) => line.event === event && (extra?.(line) ?? true));
    const seen: LogLine[] = [
      await find('api', 'document.published'),
      await find('api', 'public_link.revoked'),
      await find('api', 'document.unpublished'),
      await find('api', 'webhook.duplicate_delivery'),
      await find('collab', 'collab.update_rejected', (line) => line.reason === 'invalid'),
      await lineOf('worker', (line) => line.event === 'search.indexed'),
      await lineOf('worker', (line) => line.event === 'revalidate.sent'),
    ];
    socket.close();

    // the format: JSON with a level, a time, the event name, a message and the id of the request behind it
    for (const line of seen) {
      expect(typeof line.level).toBe('number');
      expect(typeof line.time).toBe('number');
      expect(typeof line.msg).toBe('string');
      expect(typeof line.event).toBe('string');
      expect(typeof line.correlationId).toBe('string');
      expect((line.correlationId as string).length).toBeGreaterThan(7);
    }

    // redaction: nothing that authenticates anybody may be in a log, whichever service wrote it
    const secrets = [
      user.password,
      ...(await page.context().cookies())
        .filter((cookie) => ['cd_at', 'cd_rt'].includes(cookie.name))
        .map((cookie) => cookie.value),
    ];
    for (const service of SERVICES) {
      const { raw } = await logsOf(service, started);
      for (const secret of secrets) expect(raw, `${service} logged a secret`).not.toContain(secret);
    }
  });
});
