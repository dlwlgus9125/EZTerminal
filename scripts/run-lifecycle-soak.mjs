import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('e2e:lifecycle-soak must be run through pnpm');

const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
if (!/^[0-9a-f]{40}$/.test(gitHead)) {
  throw new Error(`git did not return a full source SHA: ${gitHead}`);
}

const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
if (dirty) {
  throw new Error(`desktop lifecycle soak requires a clean worktree:\n${dirty}`);
}

const reportPath = process.env.EZTERMINAL_LIFECYCLE_SOAK_REPORT_PATH
  || path.join(root, 'release-assets', 'desktop-lifecycle-soak-report.json');
const result = spawnSync(
  process.execPath,
  [pnpmCli, 'exec', 'playwright', 'test', 'e2e/lifecycle-soak.spec.ts'],
  {
    cwd: root,
    env: {
      ...process.env,
      EZTERMINAL_BUILD_SHA: gitHead,
      VITE_BUILD_SHA: gitHead,
      EZTERMINAL_PLAYWRIGHT_RETRIES: '0',
      EZTERMINAL_RUN_LIFECYCLE_SOAK: '1',
      EZTERMINAL_LIFECYCLE_SOAK_REPORT_PATH: reportPath,
    },
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
