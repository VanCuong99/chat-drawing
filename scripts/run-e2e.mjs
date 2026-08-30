import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runId = randomBytes(6).toString('hex');
const databaseName = `net_e2e_${runId}`;
const databaseUser = 'net_e2e';
const nextDistDir = `.next-e2e-${runId}`;
const nextDistPath = join(process.cwd(), 'apps', 'web', nextDistDir);
const nextTsconfigName = `tsconfig.e2e-${runId}.json`;
const nextTsconfigPath = join(process.cwd(), 'apps', 'web', nextTsconfigName);
const postgresDir = mkdtempSync(join(tmpdir(), 'net-e2e-postgres-'));
const uploadDir = mkdtempSync(join(tmpdir(), 'net-e2e-uploads-'));
let postgresStarted = false;
let playwrightProcess;
let shuttingDown = false;
let cleaned = false;

function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback port for E2E.'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stopPostgres() {
  if (!postgresStarted) return;
  spawnSync('pg_ctl', ['-D', postgresDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
  postgresStarted = false;
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  stopPostgres();
  rmSync(postgresDir, { recursive: true, force: true });
  rmSync(uploadDir, { recursive: true, force: true });
  rmSync(nextDistPath, { recursive: true, force: true });
  rmSync(nextTsconfigPath, { force: true });
}

function stopPlaywrightTree(signal) {
  if (!playwrightProcess?.pid) return;
  try {
    if (process.platform === 'win32') playwrightProcess.kill(signal);
    else process.kill(-playwrightProcess.pid, signal);
  } catch {
    // The child process group has already stopped.
  }
}

function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPlaywrightTree(signal);
  cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGHUP', () => handleSignal('SIGTERM'));
process.once('exit', cleanup);

try {
  for (const command of ['initdb', 'pg_ctl', 'createdb']) {
    if (!commandExists(command)) {
      throw new Error(`Missing ${command}. Install PostgreSQL command-line tools before running E2E.`);
    }
  }

  const [postgresPort, apiPort, webPort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
  run('initdb', ['-D', postgresDir, '--username', databaseUser, '--auth', 'trust', '--no-locale', '--encoding', 'UTF8'], { stdio: 'ignore' });
  run('pg_ctl', ['-D', postgresDir, '-o', `-h 127.0.0.1 -p ${postgresPort} -F`, '-w', 'start'], { stdio: 'ignore' });
  postgresStarted = true;
  run('createdb', ['--host', '127.0.0.1', '--port', String(postgresPort), '--username', databaseUser, databaseName], { stdio: 'ignore' });

  const databaseUrl = `postgresql://${databaseUser}@127.0.0.1:${postgresPort}/${databaseName}`;
  copyFileSync(join(process.cwd(), 'apps', 'web', 'tsconfig.json'), nextTsconfigPath);
  const environment = {
    ...process.env,
    NET_E2E_MANAGED_DATABASE: '1',
    NET_E2E_API_PORT: String(apiPort),
    NET_E2E_WEB_PORT: String(webPort),
    NET_E2E_UPLOAD_DIR: uploadDir,
    NET_E2E_NEXT_DIST_DIR: nextDistDir,
    NET_E2E_TSCONFIG_PATH: nextTsconfigName,
    DATABASE_URL: databaseUrl,
  };

  const migration = spawnSync('pnpm', ['db:migrate'], { env: environment, stdio: 'inherit' });
  if (migration.status !== 0) throw new Error('Drizzle migration failed for the ephemeral E2E database.');

  const playwrightArgs = process.argv.slice(2);
  if (playwrightArgs[0] === '--') playwrightArgs.shift();
  playwrightProcess = spawn('pnpm', ['exec', 'playwright', 'test', '--reporter=list', ...playwrightArgs], {
    detached: process.platform !== 'win32',
    env: environment,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    playwrightProcess.once('error', reject);
    playwrightProcess.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  stopPlaywrightTree('SIGTERM');
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'E2E runner failed.');
  process.exitCode = 1;
} finally {
  cleanup();
}
