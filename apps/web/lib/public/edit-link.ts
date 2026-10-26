import { EDIT_TOKEN_PATTERN, type EditLinkState, editLinkStateSchema } from '@collab-docs/shared';
import { isApiError } from '@/lib/api/errors';
import { apiPublic } from '@/lib/api/public';

/** What `/e/<token>` shows: the editor, or an explanation of why there is none. */
export type EditLinkLookup =
  | { status: 'live'; link: EditLinkState }
  | { status: 'expired' }
  | { status: 'deleted' }
  | { status: 'unknown' };

/**
 * Asks the api whether an edit link works. Never cached: revoking a link has to take effect on the next visit.
 * Costs one anonymous request; the token stays on the server side of this call.
 */
export async function lookupEditLink(token: string): Promise<EditLinkLookup> {
  if (!EDIT_TOKEN_PATTERN.test(token)) return { status: 'unknown' };
  try {
    const link = await apiPublic(`/public/links/${encodeURIComponent(token)}`, {
      schema: editLinkStateSchema,
      cache: 'no-store',
    });
    return { status: 'live', link };
  } catch (error) {
    if (isApiError(error)) {
      if (error.status === 404) return { status: 'unknown' };
      if (error.status === 410) {
        return { status: error.code === 'DOCUMENT_DELETED' ? 'deleted' : 'expired' };
      }
    }
    throw error;
  }
}
