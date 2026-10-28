// First import of the security suite. Small limits make the abuse cases cheap to provoke; they apply to this suite only
// (every spec file runs in a process of its own). Redis is shared with the other collab suites, so this one never
// flushes it: its documents, users and rooms are new for every test.
process.env.COLLAB_MAX_MESSAGES_PER_10S = '40';
process.env.COLLAB_MAX_DOCUMENT_BYTES = '20000';
process.env.COLLAB_MAX_AWARENESS_BYTES = '512';
