import { describe, expect, it } from 'vitest';
import { workspaceIdFromPath } from './last-workspace';

const ID = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('workspaceIdFromPath', () => {
  it.each([
    `/workspaces/${ID}`,
    `/workspaces/${ID}/`,
    `/workspaces/${ID}/settings`,
    `/workspaces/${ID}/documents/anything`,
  ])('reads %s', (path) => {
    expect(workspaceIdFromPath(path)).toBe(ID);
  });

  it.each([
    '/workspaces',
    '/workspaces/',
    '/workspaces/new',
    '/workspaces/not-a-uuid/settings',
    `/x/workspaces/${ID}`,
    `/workspaces/${ID}extra`,
    '/',
  ])('ignores %s', (path) => {
    expect(workspaceIdFromPath(path)).toBeNull();
  });
});
