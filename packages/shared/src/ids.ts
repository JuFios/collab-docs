/** A UUID without anchors, for building other expressions; match it case-insensitively. */
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A whole value that is a UUID (any version, either case). Checked before an id reaches a `::uuid` cast. */
export const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'i');
