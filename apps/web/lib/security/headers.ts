// Imported by next.config.ts, so it must stay free of path aliases and of anything that needs the Next runtime.

interface SecurityHeaderEnv {
  /** Where browsers fetch images from and upload them to (`S3_PUBLIC_ENDPOINT`). */
  s3PublicEndpoint: string;
  /** The WebSocket endpoint of the collab service (`COLLAB_PUBLIC_URL`). */
  collabPublicUrl: string;
  /** `next dev`: React's refresh runtime needs `eval`, and hot reload talks over a WebSocket. */
  development: boolean;
  /**
   * Per-request nonce for pages that are rendered on every request (the signed-in workspace). Next reads it from
   * the request's policy and puts it on its own scripts; inline scripts without it are refused.
   */
  nonce?: string;
}

interface HeaderEntry {
  key: string;
  value: string;
}

const originOf = (url: string): string => new URL(url).origin;

/**
 * Two policies (spec P18). The signed-in workspace, where other people's content meets a live session, is rendered
 * per request anyway, so the edge middleware gives it a nonce and `'strict-dynamic'`: only scripts Next marked with
 * the nonce, and what they load, run. Pages that are static or regenerated (published pages, sign-in, landing) cannot
 * carry a per-request nonce without losing ISR, so they keep the static policy with `'unsafe-inline'`, which Next's
 * hydration data needs. Both close `object-src`, `base-uri`, `frame-ancestors` and `form-action`, allow nothing from a
 * third party, and the content the app renders is sanitised on the way in (README, "Security").
 */
export function contentSecurityPolicy(env: SecurityHeaderEnv): string {
  const s3 = originOf(env.s3PublicEndpoint);
  const collab = originOf(env.collabPublicUrl);
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      ...(env.nonce ? [`'nonce-${env.nonce}'`, "'strict-dynamic'"] : ["'unsafe-inline'"]),
      ...(env.development ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', s3],
    'font-src': ["'self'", 'data:'],
    // the api and the event stream are same-origin (rewrite); uploads go to object storage, editing to collab
    'connect-src': ["'self'", s3, collab],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

export function securityHeaders(env: SecurityHeaderEnv): HeaderEntry[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // frame-ancestors is the modern form; this one covers browsers that ignore it
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
  ];
}

/** Staging answers over TLS; browsers ignore the header on plain HTTP, so it can be sent unconditionally there. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';
