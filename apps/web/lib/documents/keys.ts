export const treeKey = (workspaceId: string) => ['tree', workspaceId] as const;
export const DOCUMENTS_KEY = ['document'] as const;
export const documentKey = (documentId: string) => [...DOCUMENTS_KEY, documentId] as const;
export const trashKey = (workspaceId: string) => ['trash', workspaceId] as const;
