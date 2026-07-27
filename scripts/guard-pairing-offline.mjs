#!/usr/bin/env node
/**
 * The pairing QR must be drawn locally.
 *
 * Two independent reasons, either of which is enough: the packaged app runs
 * under a CSP that forbids remote images and scripts, so a hosted generator
 * would simply fail to load; and a pairing code handed to a third-party
 * service is a pairing code that has left the machine.
 *
 * Checked by reading source, so this holds whether or not anyone has a network
 * when the tests run:
 *
 *   1. The QR dialog draws from a bundled encoder and contains no URL.
 *   2. The scanner decodes with a bundled decoder and never uploads a frame.
 *   3. Neither dependency is a stub that would silently fall back to a network.
 *
 * Run: node scripts/guard-pairing-offline.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const failures = [];

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

/** Any absolute URL in code that runs while pairing is open. */
const REMOTE_URL = /["'`](https?:)?\/\/[^"'`\s]+["'`]/u;
/** Anything that could put bytes on a wire. */
const NETWORK_CALL = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\()\s*\(/u;

const SURFACES = [
  { file: 'src/renderer/PairingQrDialog.tsx', what: 'the QR dialog' },
  { file: 'mobile/src/PairingScanner.tsx', what: 'the pairing scanner' },
];

for (const { file, what } of SURFACES) {
  const source = read(file);
  const url = REMOTE_URL.exec(source);
  if (url) failures.push(`${what} (${file}) references ${url[0]}. Pairing must not touch the network.`);
  const call = NETWORK_CALL.exec(source);
  if (call) failures.push(`${what} (${file}) calls ${call[1]}. Pairing must not touch the network.`);
}

// The encoder and decoder have to actually exist and actually work, or the
// checks above would pass on a surface that silently renders nothing.
try {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData('ezterminal://pair?endpoint=ws://127.0.0.1:1&code=7C2F-91KD');
  qr.make();
  if (qr.getModuleCount() < 21) failures.push('qrcode-generator produced an impossible symbol.');
} catch (error) {
  failures.push(`qrcode-generator is not usable offline: ${String(error)}`);
}

try {
  require.resolve('jsqr', { paths: [path.join(root, 'mobile')] });
} catch (error) {
  failures.push(`jsqr is not resolvable from the mobile package: ${String(error)}`);
}

// The permission is what makes the scanner possible, and it must stay optional
// so a phone without a camera can still install and pair by typing.
const manifest = read('mobile/android/app/src/main/AndroidManifest.xml');
if (!manifest.includes('android.permission.CAMERA')) {
  failures.push('AndroidManifest.xml no longer declares CAMERA; the scanner cannot open.');
}
if (!/android:name="android\.hardware\.camera"\s+android:required="false"/u.test(manifest)) {
  failures.push(
    'AndroidManifest.xml must declare the camera feature as NOT required, or a device '
    + 'without one cannot install the app at all.',
  );
}

if (failures.length > 0) {
  console.error('guard:pairing-offline FAILED\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('guard:pairing-offline OK — QR generation and scanning stay on the device.');
