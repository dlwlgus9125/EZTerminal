import { spawnSync } from 'node:child_process';
import path from 'node:path';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('make-distributables must be run through pnpm');

function pnpm(...args) {
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(process.env.WINDOWS_SIGN_CERT_FILE && !process.env.CSC_LINK
        ? { CSC_LINK: process.env.WINDOWS_SIGN_CERT_FILE }
        : {}),
      ...(process.env.WINDOWS_SIGN_CERT_PASSWORD && !process.env.CSC_KEY_PASSWORD
        ? { CSC_KEY_PASSWORD: process.env.WINDOWS_SIGN_CERT_PASSWORD }
        : {}),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'win32') {
  pnpm('exec', 'electron-forge', 'make');
  process.exit(0);
}

pnpm('build:remote-host');
const packageRoot = process.env.EZ_OUT_DIR
  ? path.resolve(process.env.EZ_OUT_DIR)
  : path.resolve('out');
const prepackaged = path.join(packageRoot, 'EZTerminal-win32-x64');
pnpm('exec', 'electron-forge', 'package', '--platform=win32', '--arch=x64');
pnpm(
  'exec',
  'electron-builder',
  '--win',
  'nsis',
  '--x64',
  '--prepackaged',
  prepackaged,
  '--config',
  'electron-builder.yml',
);
