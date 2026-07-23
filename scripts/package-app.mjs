import { spawnSync } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('package-app must be run through pnpm');

function pnpm(...args) {
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform === 'win32') pnpm('build:remote-host');
pnpm('exec', 'electron-forge', 'package');
