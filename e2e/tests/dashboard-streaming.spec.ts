import { expect, test } from '../fixtures';

const delay = Number(process.env.DASHBOARD_BLOCK_DELAY_MS ?? 0);

// The stack must run with DASHBOARD_BLOCK_DELAY_MS set (README, "Running e2e"); otherwise there is nothing to observe.
test.skip(!(delay > 0), 'start the stack with DASHBOARD_BLOCK_DELAY_MS=600 to observe streaming');

test('the dashboard streams: skeletons are flushed before the blocks have their data', async ({
  signedInPage: page,
  baseURL,
}) => {
  const origin = baseURL ?? 'http://localhost:3000';
  // cookie-authenticated writes carry the CSRF Origin check, which the api compares with WEB_ORIGIN
  const headers = { origin: 'http://localhost:3000' };
  const created = await page.request.post('/api/workspaces', {
    data: { name: 'Streaming' },
    headers,
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const cookie = (await page.context().cookies())
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
  const startedAt = Date.now();
  const response = await fetch(new URL(`/w/${id}`, origin), { headers: { cookie } });
  expect(response.status).toBe(200);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  let skeletonAt: number | undefined;
  let dataAt: number | undefined;
  let dataInFirstFlush = false;
  // The usage block's meter text. The document tree in the sidebar is rendered with the layout, so a document title
  // would be in the first flush too and would say nothing about the blocks.
  const marker = 'aria-valuetext="1 of 3"';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
    const elapsed = Date.now() - startedAt;
    if (skeletonAt === undefined && received.includes('Loading recent documents')) {
      skeletonAt = elapsed;
      dataInFirstFlush = received.includes(marker);
    }
    if (dataAt === undefined && received.includes(marker)) dataAt = elapsed;
  }

  expect(skeletonAt, 'the skeleton of the recent-documents block is in the response').toBeDefined();
  expect(dataAt, 'the usage data arrives in the same response').toBeDefined();
  // every block shows its own skeleton...
  for (const label of ['Loading members', 'Loading plan and usage', 'Loading shared documents']) {
    expect(received).toContain(label);
  }
  // ...the skeletons were flushed without any of the data, and the data followed the artificial delay later
  expect(dataInFirstFlush).toBe(false);
  expect(dataAt! - skeletonAt!).toBeGreaterThan(delay * 0.5);
});
