import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  APP_DIR,
  APP_EXE,
  EVIDENCE,
  INSTALLER_INPUT,
  PAYLOAD_NAMES,
  PAYLOAD_SIGNED,
  REMOTE_HOST_EXE,
  RETAINED_UNINSTALLER,
  SETUP_EXE,
  assertNoLocalSigningCredentials,
  assertWindows,
  copyFile,
  ensureExactFiles,
  pnpm,
  recreateDirectory,
  verify,
} from './signpath-windows-lib.mjs';

assertWindows();
assertNoLocalSigningCredentials();
ensureExactFiles(PAYLOAD_SIGNED, PAYLOAD_NAMES);
verify(
  PAYLOAD_NAMES.map((name) => path.join(PAYLOAD_SIGNED, name)),
  'Valid',
  path.join(EVIDENCE, 'signed-payload.json'),
);

copyFile(path.join(PAYLOAD_SIGNED, PAYLOAD_NAMES[0]), APP_EXE);
copyFile(path.join(PAYLOAD_SIGNED, PAYLOAD_NAMES[1]), REMOTE_HOST_EXE);
copyFile(path.join(PAYLOAD_SIGNED, PAYLOAD_NAMES[2]), RETAINED_UNINSTALLER);
verify([APP_EXE, REMOTE_HOST_EXE, RETAINED_UNINSTALLER], 'Valid');

rmSync(path.dirname(SETUP_EXE), { recursive: true, force: true });
pnpm([
  'exec', 'electron-builder', '--win', 'nsis', '--x64', '--prepackaged', APP_DIR,
  '--config', 'electron-builder.signpath.yml', '--publish', 'never',
], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  EZTERMINAL_SIGNPATH_MODE: 'inject',
  EZTERMINAL_SIGNPATH_UNINSTALLER_PATH: RETAINED_UNINSTALLER,
});
verify([APP_EXE, REMOTE_HOST_EXE, RETAINED_UNINSTALLER], 'Valid');
verify([SETUP_EXE], 'NotSigned');

recreateDirectory(INSTALLER_INPUT);
copyFile(SETUP_EXE, path.join(INSTALLER_INPUT, 'EZTerminal-Setup.exe'));
ensureExactFiles(INSTALLER_INPUT, ['EZTerminal-Setup.exe']);
console.log(`Prepared exact SignPath installer: ${INSTALLER_INPUT}`);
