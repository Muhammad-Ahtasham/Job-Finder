import type { NextConfig } from 'next';
import { loadRootDotenv } from '@jobfinder/config';

// Share the repo-root .env with the other apps (Next only auto-loads apps/web/.env*).
loadRootDotenv();

const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    // The browser only ever talks to the web origin; Next proxies /api/* to the API.
    // This keeps the session cookie first-party (no CORS, no cross-site cookies).
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
