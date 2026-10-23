import { z } from 'zod';

const treeChangedSchema = z.object({
  type: z.literal('tree.changed'),
  workspaceId: z.string().uuid(),
  version: z.number().int(),
});

const notificationCreatedSchema = z.object({
  type: z.literal('notification.created'),
  notificationId: z.string().uuid(),
});

export type WorkspaceEvent =
  z.infer<typeof treeChangedSchema> | z.infer<typeof notificationCreatedSchema>;

const schemas = {
  'tree.changed': treeChangedSchema,
  'notification.created': notificationCreatedSchema,
} as const;

export const WORKSPACE_EVENT_TYPES = Object.keys(schemas) as WorkspaceEvent['type'][];

/** Parses one SSE `data:` payload; anything malformed or unknown is dropped rather than thrown. */
export function parseWorkspaceEvent(type: string, data: string): WorkspaceEvent | null {
  const schema = schemas[type as keyof typeof schemas];
  if (!schema) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
