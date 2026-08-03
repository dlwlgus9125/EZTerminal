import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  APP_EXE,
  EVIDENCE,
  INSTALLER_SIGNED,
  PUBLISHER,
  REMOTE_HOST_EXE,
  RETAINED_UNINSTALLER,
  SETUP_EXE,
  assertWindows,
  copyFile,
  ensureExactFiles,
  verify,
  writeJson,
} from './signpath-windows-lib.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : (process.argv[index + 1] ?? '').trim();
}

assertWindows();
const payloadRequestId = argument('--payload-request-id');
const installerRequestId = argument('--installer-request-id');
if (!payloadRequestId || !installerRequestId) {
  throw new Error('Both --payload-request-id and --installer-request-id are required.');
}

ensureExactFiles(INSTALLER_SIGNED, ['EZTerminal-Setup.exe']);
const signedSetup = path.join(INSTALLER_SIGNED, 'EZTerminal-Setup.exe');
verify([signedSetup], 'Valid');
copyFile(signedSetup, SETUP_EXE);
rmSync(`${SETUP_EXE}.blockmap`, { force: true });
rmSync(path.join(path.dirname(SETUP_EXE), 'latest.yml'), { force: true });

const evidenceFiles = [APP_EXE, REMOTE_HOST_EXE, RETAINED_UNINSTALLER, SETUP_EXE];
const rawEvidencePath = path.join(EVIDENCE, 'windows-authenticode-files.json');
verify(evidenceFiles, 'Valid', rawEvidencePath);
const rawEvidence = JSON.parse(readFileSync(rawEvidencePath, 'utf8'));
writeJson(path.join(EVIDENCE, 'windows-authenticode.json'), {
  schemaVersion: 1,
  expected: 'Valid',
  publisher: PUBLISHER,
  timestampRequired: true,
  signingRequestIds: {
    payload: payloadRequestId,
    installer: installerRequestId,
  },
  files: rawEvidence.files,
});
console.log(`Finalized signed Windows installer: ${SETUP_EXE}`);
