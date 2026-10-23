import { describe, expect, it } from 'vitest';
import { workspaceIdFromPath } from './last-workspace';

const ID = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('workspaceIdFromPath', () => {
  it.each([`/w/${ID}`, `/w/${ID}/`, `/w/${ID}/settings`, `/w/${ID}/d/anything`])(
    'reads %s',
    (path) => {
      expect(workspaceIdFromPath(path)).toBe(ID);
    },
  );

  it.each(['/w', '/w/', '/w/new', '/w/not-a-uuid/settings', `/x/w/${ID}`, `/w/${ID}extra`, '/'])(
    'ignores %s',
    (path) => {
      expect(workspaceIdFromPath(path)).toBeNull();
    },
  );
});
