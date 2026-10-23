import path from 'node:path';
import type { NextConfig } from 'next';

// Rewrites are compiled into the routes manifest, so unlike the middleware this destination is fixed at
// build time (the Dockerfile exposes it as a build arg; the default matches docker compose).
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://api:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  // trace workspace packages from the monorepo root so the standalone bundle includes them
  outputFileTracingRoot: path.join(__dirname, '../../'),
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    // the browser stays same-origin: cookies, CSRF Origin checks and SSE all go through this proxy
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
