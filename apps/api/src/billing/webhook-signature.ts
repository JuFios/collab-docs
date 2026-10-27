import { createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_TOLERANCE_SECONDS } from '@collab-docs/shared';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the shape of the `Mock-Signature` header. */
export function signWebhook(secret: string, body: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export type SignatureVerdict = 'valid' | 'malformed' | 'mismatch' | 'expired';

/**
 * Checks a delivery: the HMAC over the exact bytes received (compared in constant time) and the age of its
 * timestamp. The signature is checked first, so a forged timestamp is a `mismatch`, not an `expired`.
 */
export function verifyWebhook(options: {
  secret: string;
  body: Buffer | string;
  header: string | undefined;
  nowMs?: number;
  toleranceSeconds?: number;
}): SignatureVerdict {
  const {
    secret,
    body,
    header,
    nowMs = Date.now(),
    toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
  } = options;
  const parsed = parseHeader(header);
  if (!parsed) return 'malformed';

  const expected = Buffer.from(hmac(secret, parsed.timestamp, body), 'hex');
  const matches = parsed.signatures.some((signature) => {
    const candidate = Buffer.from(signature, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!matches) return 'mismatch';

  return Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp) > toleranceSeconds
    ? 'expired'
    : 'valid';
}

function hmac(secret: string, timestamp: number, body: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

function parseHeader(header: string | undefined) {
  if (!header) return null;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && value && /^[0-9a-f]+$/i.test(value)) signatures.push(value);
  }
  return timestamp !== undefined && signatures.length > 0 ? { timestamp, signatures } : null;
}
