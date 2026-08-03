import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  APP_DIR,
  APP_EXE,
  EVIDENCE,
  PAYLOAD_INPUT,
  PAYLOAD_NAMES,
  REMOTE_HOST_EXE,
  RETAINED,
  RETAINED_UNINSTALLER,
  SETUP_EXE,
  SIGNPATH_ROOT,
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
recreateDirectory(SIGNPATH_ROOT);
mkdirSync(RETAINED, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

rmSync(APP_DIR, { recursive: true, force: true });
rmSync(path.dirname(SETUP_EXE), { recursive: true, force: true });
pnpm(['build:remote-host']);
pnpm(['exec', 'electron-forge', 'package', '--platform=win32', '--arch=x64'], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
});
verify([APP_EXE, REMOTE_HOST_EXE], 'NotSigned');

pnpm([
  'exec', 'electron-builder', '--win', 'nsis', '--x64', '--prepackaged', APP_DIR,
  '--config', 'electron-builder.signpath.yml', '--publish', 'never',
], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  EZTERMINAL_SIGNPATH_MODE: 'capture',
  EZTERMINAL_SIGNPATH_UNINSTALLER_PATH: RETAINED_UNINSTALLER,
});

recreateDirectory(PAYLOAD_INPUT);
copyFile(APP_EXE, path.join(PAYLOAD_INPUT, PAYLOAD_NAMES[0]));
copyFile(REMOTE_HOST_EXE, path.join(PAYLOAD_INPUT, PAYLOAD_NAMES[1]));
copyFile(RETAINED_UNINSTALLER, path.join(PAYLOAD_INPUT, PAYLOAD_NAMES[2]));
ensureExactFiles(PAYLOAD_INPUT, PAYLOAD_NAMES);
verify(
  PAYLOAD_NAMES.map((name) => path.join(PAYLOAD_INPUT, name)),
  'NotSigned',
  path.join(EVIDENCE, 'unsigned-payload.json'),
);
verify(
  [APP_EXE, REMOTE_HOST_EXE, RETAINED_UNINSTALLER, SETUP_EXE],
  'NotSigned',
  path.join(EVIDENCE, 'unsigned-windows.json'),
);

console.log(`Prepared unsigned Windows installer and exact SignPath payload: ${PAYLOAD_INPUT}`);
