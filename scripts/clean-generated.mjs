import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = process.cwd();
const generatedPaths = [
  '.next',
  '.vinext',
  '.wrangler',
  '.playwright-cli',
  'dist',
  'test-results',
  'playwright-report',
  'next-env.d.ts',
  'apps/web/.next',
  'apps/web/.vinext',
  'apps/web/.wrangler',
  'apps/web/dist',
  'apps/web/next-env.d.ts',
  'apps/api/dist',
  'packages/database/dist',
  'packages/pigment/dist',
];

for (const path of generatedPaths) {
  await rm(resolve(workspace, path), { recursive: true, force: true });
}

console.log(`Cleaned ${generatedPaths.length} reproducible build/test path(s).`);
