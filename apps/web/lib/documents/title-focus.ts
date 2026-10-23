let pending: string | null = null;

/** A freshly created document should open with its title selected; the shell consumes this on mount. */
export function requestTitleFocus(documentId: string): void {
  pending = documentId;
}

export function consumeTitleFocus(documentId: string): boolean {
  if (pending !== documentId) return false;
  pending = null;
  return true;
}
