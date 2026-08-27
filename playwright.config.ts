import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
process.env.DATABASE_URL ??= 'postgresql://net:net@localhost:5432/net';
process.env.AUTH_JWT_SECRET ??= 'net-e2e-local-auth-secret-never-use-in-production';
process.env.CRON_SECRET ??= 'net-e2e-local-cron-secret-never-use-in-production';

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
    baseURL: 'http://localhost:3000',
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
      command: `pnpm build:packages && TRUST_PROXY_HOPS=1 E2E_RATE_LIMIT_SECRET=${e2eRateLimitSecret} API_REQUEST_BURST=1000 API_MAX_ACTIVE_PER_IP=200 pnpm dev:api`,
      url: 'http://localhost:3001/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev:web',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
