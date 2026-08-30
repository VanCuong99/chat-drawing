import type { NextConfig } from 'next';

const apiOrigin = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
if (process.env.VERCEL && (!process.env.NEXT_PUBLIC_API_URL || !process.env.NEXT_PUBLIC_REALTIME_URL)) {
  throw new Error('NEXT_PUBLIC_API_URL and NEXT_PUBLIC_REALTIME_URL are required for Vercel deployments.');
}

const nextConfig: NextConfig = {
  distDir: process.env.NET_E2E_NEXT_DIST_DIR ?? '.next',
  typescript: process.env.NET_E2E_TSCONFIG_PATH
    ? { tsconfigPath: process.env.NET_E2E_TSCONFIG_PATH }
    : undefined,
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  async rewrites() {
    return {
      fallback: [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }],
    };
  },
};

export default nextConfig;
