import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // trace workspace packages from the monorepo root so the standalone bundle includes them
  outputFileTracingRoot: path.join(__dirname, '../../'),
  reactStrictMode: true,
};

export default nextConfig;
