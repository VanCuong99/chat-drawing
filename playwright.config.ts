import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
const apiPort = Number(process.env.NET_E2E_API_PORT);
const webPort = Number(process.env.NET_E2E_WEB_PORT);
const uploadDir = process.env.NET_E2E_UPLOAD_DIR;
const nextDistDir = process.env.NET_E2E_NEXT_DIST_DIR;
const nextTsconfigPath = process.env.NET_E2E_TSCONFIG_PATH;

if (process.env.NET_E2E_MANAGED_DATABASE !== '1' || !databaseUrl) {
  throw new Error('E2E requires its managed ephemeral database. Run `pnpm test:e2e` instead of invoking Playwright directly.');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (
  !['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)
  || !loopbackHosts.has(parsedDatabaseUrl.hostname)
  || parsedDatabaseUrl.username !== 'net_e2e'
  || !/^net_e2e_[a-f0-9]{12}$/.test(databaseName)
) {
  throw new Error('Refusing to run E2E against a non-ephemeral or non-loopback PostgreSQL database.');
}
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535 || !Number.isInteger(webPort) || webPort < 1 || webPort > 65_535 || apiPort === webPort) {
  throw new Error('E2E requires distinct managed API and web ports. Run `pnpm test:e2e`.');
}
if (
  !uploadDir
  || !nextDistDir
  || !/^\.next-e2e-[a-f0-9]{12}$/.test(nextDistDir)
  || !nextTsconfigPath
  || !/^tsconfig\.e2e-[a-f0-9]{12}\.json$/.test(nextTsconfigPath)
) {
  throw new Error('E2E requires managed temporary upload, Next.js build, and TypeScript config files. Run `pnpm test:e2e`.');
}

const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const e2eJwtSecret = 'net-e2e-local-auth-secret-never-use-in-production';
const e2eCronSecret = 'net-e2e-local-cron-secret-never-use-in-production';
Object.assign(process.env, {
  NODE_ENV: 'test',
  AUTH_JWT_SECRET: e2eJwtSecret,
  CRON_SECRET: e2eCronSecret,
  REDIS_URL: '',
  STORAGE_DRIVER: 'local',
  BLOB_READ_WRITE_TOKEN: '',
  UPLOAD_DIR: uploadDir,
  WEB_ORIGIN: webOrigin,
  API_PORT: String(apiPort),
  NET_E2E_API_ORIGIN: apiOrigin,
  NET_E2E_WEB_ORIGIN: webOrigin,
  NEON_AUTH_BASE_URL: 'http://127.0.0.1:9',
  NEON_AUTH_COOKIE_SECRET: 'net-e2e-cookie-secret-never-use-in-production',
});

const runAddress = `2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`;
const e2eRateLimitSecret = 'net-e2e-local-only';
const e2eRunId = randomBytes(12).toString('base64url');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: webOrigin,
    extraHTTPHeaders: {
      'x-forwarded-for': runAddress,
      'x-net-e2e-rate-key': `${e2eRateLimitSecret}.${e2eRunId}`,
    },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } }],
  webServer: [
    {
      command: `pnpm build:packages && TRUST_PROXY_HOPS=1 E2E_RATE_LIMIT_SECRET=${e2eRateLimitSecret} GUEST_CREATE_LIMIT=1000 API_REQUEST_BURST=1000 API_MAX_ACTIVE_PER_IP=200 DATABASE_CONNECTION_TIMEOUT_MS=30000 pnpm dev:api`,
      url: `${apiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `NEXT_PUBLIC_API_URL=${apiOrigin} NEXT_PUBLIC_API_REQUEST_URL=${apiOrigin} NEXT_PUBLIC_REALTIME_URL=${apiOrigin}/chat pnpm --filter @net/web exec next dev --webpack --hostname 127.0.0.1 --port ${webPort}`,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
