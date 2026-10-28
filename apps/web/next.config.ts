import path from 'node:path';
import type { NextConfig } from 'next';
import { securityHeaders } from './lib/security/headers';

// Rewrites are compiled into the routes manifest, so unlike the middleware this destination is fixed at
// build time (the Dockerfile exposes it as a build arg; the default matches docker compose).
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://api:4000';
// Headers are compiled into the routes manifest too: the origins the CSP names are fixed at build time
// (the Dockerfile exposes them as build args; the defaults match docker compose).
const csp = {
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  collabPublicUrl: process.env.COLLAB_PUBLIC_URL ?? 'ws://localhost:4001',
  development: process.env.NODE_ENV !== 'production',
};

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
        headers: securityHeaders(csp),
      },
    ];
  },
};

export default nextConfig;
