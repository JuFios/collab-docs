/** Remembers the workspace the user opened last, so `/workspaces` can send them straight back. */
export const LAST_WORKSPACE_COOKIE = 'cd_ws';
export const LAST_WORKSPACE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const WORKSPACE_PATH =
  /^\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The workspace id of a `/workspaces/<id>/…` path, or null for any other path. */
export function workspaceIdFromPath(pathname: string): string | null {
  return WORKSPACE_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
}
