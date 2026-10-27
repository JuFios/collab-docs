import { createHmac } from 'node:crypto';
import { WEBHOOK_TOLERANCE_SECONDS } from '@collab-docs/shared';
import { signWebhook, verifyWebhook } from './webhook-signature';

const SECRET = 'test-signing-secret-0123456789';
const BODY = '{"id":"evt_00000000000000000000000000000001","type":"x","created":1,"data":{}}';
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

const verify = (header: string | undefined, overrides: { body?: string; nowMs?: number } = {}) =>
  verifyWebhook({ secret: SECRET, body: BODY, header, nowMs: NOW, ...overrides });

describe('webhook signature', () => {
  it('accepts a delivery signed with the secret', () => {
    expect(verify(signWebhook(SECRET, BODY, NOW))).toBe('valid');
  });

  it('accepts the raw bytes as a Buffer', () => {
    const header = signWebhook(SECRET, BODY, NOW);
    expect(verifyWebhook({ secret: SECRET, body: Buffer.from(BODY), header, nowMs: NOW })).toBe(
      'valid',
    );
  });

  it('has the t=<seconds>,v1=<hex> shape', () => {
    expect(signWebhook(SECRET, BODY, NOW)).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
  });

  describe('forged', () => {
    it('refuses a body that changed after signing', () => {
      const header = signWebhook(SECRET, BODY, NOW);
      expect(verify(header, { body: BODY.replace('"x"', '"y"') })).toBe('mismatch');
    });

    it('refuses another secret', () => {
      expect(verify(signWebhook('another-secret-0123456789', BODY, NOW))).toBe('mismatch');
    });

    it('refuses a timestamp edited after signing: it is part of the signed text', () => {
      const header = signWebhook(SECRET, BODY, NOW).replace(/t=\d+/, `t=${NOW / 1000 + 1}`);
      expect(verify(header)).toBe('mismatch');
    });

    it('refuses a signature of the wrong length without throwing', () => {
      expect(verify(`t=${NOW / 1000},v1=abcd`)).toBe('mismatch');
    });
  });

  describe('expired', () => {
    it('refuses a delivery older than the tolerance', () => {
      const old = NOW - (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000;
      expect(verify(signWebhook(SECRET, BODY, old))).toBe('expired');
    });

    it('refuses a delivery dated in the future by more than the tolerance', () => {
      const ahead = NOW + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000;
      expect(verify(signWebhook(SECRET, BODY, ahead))).toBe('expired');
    });

    it('accepts a delivery exactly at the tolerance', () => {
      const edge = NOW - WEBHOOK_TOLERANCE_SECONDS * 1000;
      expect(verify(signWebhook(SECRET, BODY, edge))).toBe('valid');
    });
  });

  describe('malformed', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['without a signature', `t=${NOW / 1000}`],
      ['without a timestamp', `v1=${'a'.repeat(64)}`],
      ['with a non-numeric timestamp', `t=soon,v1=${'a'.repeat(64)}`],
      ['with a non-hex signature', `t=${NOW / 1000},v1=${'z'.repeat(64)}`],
    ])('refuses a header that is %s', (_name, header) => {
      expect(verify(header)).toBe('malformed');
    });
  });

  it('accepts any of several v1 signatures (a secret being rotated)', () => {
    const seconds = NOW / 1000;
    const good = createHmac('sha256', SECRET).update(`${seconds}.${BODY}`).digest('hex');
    expect(verify(`t=${seconds},v1=${'0'.repeat(64)},v1=${good}`)).toBe('valid');
  });
});
