import { Prisma } from '@collab-docs/db';

/**
 * The rules of `resolveDocumentAccess` (spec §4) for "may this user at least view this document", as a predicate
 * for raw queries: the document is not in the trash and the user is an owner/admin of its workspace, or an editor
 * who wrote it, or a member of a workspace-visible document, or holds a share. The query must name the documents
 * table `d`; `userId` is a bound parameter or a column of the query (`u.id`). Used where a list is filtered in SQL
 * (search, notifications, mention candidates) instead of resolving every row in the application.
 */
export function viewableDocumentSql(userId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    d.deleted_at IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = d.workspace_id AND wm.user_id = ${userId}
          AND (wm.role IN ('OWNER', 'ADMIN') OR d.visibility = 'WORKSPACE')
      )
      OR (
        d.created_by = ${userId}
        AND EXISTS (
          SELECT 1 FROM workspace_members wm
          WHERE wm.workspace_id = d.workspace_id AND wm.user_id = ${userId}
            AND wm.role IN ('OWNER', 'ADMIN', 'EDITOR')
        )
      )
      OR EXISTS (
        SELECT 1 FROM document_shares ds WHERE ds.document_id = d.id AND ds.user_id = ${userId}
      )
    )
  )`;
}
