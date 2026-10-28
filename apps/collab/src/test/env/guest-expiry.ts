// First import of the guest-expiry suite: the periodic permission check is set so far apart that it never runs during a
// test, so a guest can only be cut off at the moment their link expires by something that watches that moment.
process.env.COLLAB_ACCESS_RECHECK_MS = '600000';
