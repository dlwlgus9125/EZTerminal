import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const SIGNPATH_ROOT = path.resolve('out', 'signpath');
export const PAYLOAD_INPUT = path.join(SIGNPATH_ROOT, 'payload-input');
export const PAYLOAD_SIGNED = path.join(SIGNPATH_ROOT, 'payload-signed');
export const INSTALLER_INPUT = path.join(SIGNPATH_ROOT, 'installer-input');
export const INSTALLER_SIGNED = path.join(SIGNPATH_ROOT, 'installer-signed');
export const RETAINED = path.join(SIGNPATH_ROOT, 'retained');
export const EVIDENCE = path.join(SIGNPATH_ROOT, 'evidence');
export const RETAINED_UNINSTALLER = path.join(RETAINED, 'Uninstall EZTerminal.exe');
export const APP_DIR = path.resolve('out', 'EZTerminal-win32-x64');
export const APP_EXE = path.join(APP_DIR, 'EZTerminal.exe');
export const REMOTE_HOST_EXE = path.join(APP_DIR, 'resources', 'ezterminal-remote-host.exe');
export const SETUP_EXE = path.resolve('out', 'make', 'nsis', 'x64', 'EZTerminal-Setup.exe');
export const PUBLISHER = 'SignPath Foundation';
export const PAYLOAD_NAMES = [
  'EZTerminal.exe',
  'ezterminal-remote-host.exe',
  'Uninstall EZTerminal.exe',
];

export function packageVersion() {
  return JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;
}

export function assertWindows() {
  if (process.platform !== 'win32') throw new Error('SignPath Windows release scripts require Windows.');
}

export function assertNoLocalSigningCredentials() {
  const names = [
    'WINDOWS_SIGN_CERT_FILE',
    'WINDOWS_SIGN_CERT_PASSWORD',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
  ];
  const present = names.filter((name) => Boolean(process.env[name]));
  if (present.length > 0) {
    throw new Error(`Local certificate variables are forbidden in the SignPath build: ${present.join(', ')}`);
  }
}

export function ensureExactFiles(directory, expectedNames) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`Expected directory does not exist: ${directory}`);
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (entries.some((entry) => !entry.isFile()) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected artifact contents in ${directory}: ${actual.join(', ')}`);
  }
}

export function recreateDirectory(directory) {
  const relative = path.relative(path.resolve('out'), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error(`Refusing to recreate a directory outside out/: ${directory}`);
  }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

export function copyFile(source, destination) {
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Missing file: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { force: true });
}

export function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extra.env },
    encoding: extra.capture ? 'utf8' : undefined,
    stdio: extra.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (extra.capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}.`);
  }
  return extra.capture ? (result.stdout ?? '') : '';
}

export function pnpm(args, env = {}) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error('This script must be run through pnpm.');
  return run(process.execPath, [pnpmCli, ...args], { env });
}

export function verify(paths, status, outputPath) {
  const files = paths.flatMap((file) => {
    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve('scripts', 'verify-windows-signatures.ps1'),
      '-Path', file,
      '-ExpectedStatus', status,
      '-ExpectedProductName', 'EZTerminal',
      '-ExpectedProductVersion', packageVersion(),
    ];
    if (status === 'Valid') args.push('-ExpectedPublisher', PUBLISHER, '-RequireTimestamp');
    const evidence = JSON.parse(run('powershell.exe', args, { capture: true }));
    return evidence.files;
  });
  const evidence = {
    expectedStatus: status,
    expectedPublisher: status === 'Valid' ? PUBLISHER : null,
    timestampRequired: status === 'Valid',
    files,
  };
  if (outputPath) writeJson(outputPath, evidence);
  return JSON.stringify(evidence);
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
