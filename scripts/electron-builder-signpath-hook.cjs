'use strict';

const { copyFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const MODES = new Set(['capture', 'inject']);

function classifySignTarget(file) {
  const basename = path.basename(file).toLowerCase();
  if (basename === 'elevate.exe') return 'electron-builder-helper';
  if (basename.endsWith('__uninstaller.exe')) return 'uninstaller';
  if (basename === 'ezterminal-setup.exe') return 'installer';
  return 'unexpected';
}

async function sign(configuration) {
  const mode = process.env.EZTERMINAL_SIGNPATH_MODE;
  const retainedUninstaller = process.env.EZTERMINAL_SIGNPATH_UNINSTALLER_PATH;
  if (!MODES.has(mode)) {
    throw new Error(`Invalid EZTERMINAL_SIGNPATH_MODE: ${mode ?? '<unset>'}`);
  }
  if (!retainedUninstaller || !path.isAbsolute(retainedUninstaller)) {
    throw new Error('EZTERMINAL_SIGNPATH_UNINSTALLER_PATH must be an absolute path.');
  }
  if (configuration.hash !== 'sha256' || configuration.isNest) {
    throw new Error('The SignPath bridge only accepts one SHA-256 signing pass.');
  }

  const target = classifySignTarget(configuration.path);
  if (target === 'electron-builder-helper' || target === 'installer') {
    // elevate.exe is an electron-builder dependency and the final installer is
    // signed by SignPath after NSIS assembly. Neither is signed in this hook.
    return;
  }
  if (target !== 'uninstaller') {
    throw new Error(`Unexpected electron-builder signing target: ${configuration.path}`);
  }

  mkdirSync(path.dirname(retainedUninstaller), { recursive: true });
  if (mode === 'capture') {
    copyFileSync(configuration.path, retainedUninstaller);
    return;
  }
  copyFileSync(retainedUninstaller, configuration.path);
}

module.exports = { classifySignTarget, sign };
