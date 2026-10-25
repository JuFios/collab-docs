// First import of the persistence suite: the flush timers are set so far apart that only an explicit flush,
// a room unload or the shutdown writes anything, which makes "what is durable when" deterministic.
process.env.COLLAB_FLUSH_INTERVAL_MS = '60000';
process.env.COLLAB_FLUSH_MAX_WAIT_MS = '120000';
process.env.COLLAB_ROOM_IDLE_MS = '200';
