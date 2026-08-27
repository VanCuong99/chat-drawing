import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = await readFile(resolve('infra/nginx/default.conf'), 'utf8');
const isolated = source
  .replace('server web:3000;', 'server 127.0.0.1:3000;')
  .replace('server api:3001;', 'server 127.0.0.1:3001;');
const directory = await mkdtemp(join(tmpdir(), 'net-nginx-'));
const config = join(directory, 'nginx.conf');

try {
  await writeFile(config, `pid nginx.pid;\nevents {}\nhttp {\n${isolated}\n}\n`);
  const result = spawnSync('nginx', ['-t', '-p', directory, '-c', config], { encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error?.code === 'ENOENT') {
    console.error('Không tìm thấy nginx trong PATH; cài nginx để kiểm tra cú pháp ingress.');
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
