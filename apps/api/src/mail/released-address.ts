/** `.invalid` never resolves (RFC 2606), so nothing sent there reaches anybody. */
const RELEASED_DOMAIN = 'released.invalid';

/** The address an account keeps after it gave up its real one (see `EmailVerificationService.releaseStale`). */
export const releasedAddress = (userId: string): string => `${userId}@${RELEASED_DOMAIN}`;

export const isReleasedAddress = (address: string): boolean =>
  address.toLowerCase().endsWith(`@${RELEASED_DOMAIN}`);
