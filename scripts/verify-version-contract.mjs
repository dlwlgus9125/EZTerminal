import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function capture(source, pattern, label) {
  const match = source.match(pattern);
  assert(match, `Could not read ${label}.`);
  return match[1];
}

const contract = await readJson('release/version.json');
const rootPackage = await readJson('package.json');
const mobilePackage = await readJson('mobile/package.json');
const cargo = await readFile(resolve(root, 'native/remote-host/Cargo.toml'), 'utf8');
const gradle = await readFile(resolve(root, 'mobile/android/app/build.gradle'), 'utf8');
const remoteProtocol = await readFile(resolve(root, 'src/shared/remote-protocol.ts'), 'utf8');

assert(contract.schemaVersion === 1, 'release/version.json schemaVersion must be 1.');
assert(
  typeof contract.version === 'string' && /^\d+\.\d+\.\d+$/.test(contract.version),
  'release/version.json version must be a stable semantic version.',
);
assert(
  Number.isSafeInteger(contract.androidVersionCode) && contract.androidVersionCode > 0,
  'release/version.json androidVersionCode must be a positive integer.',
);
assert(
  Number.isSafeInteger(contract.protocolVersion) && contract.protocolVersion > 0,
  'release/version.json protocolVersion must be a positive integer.',
);

const cargoVersion = capture(
  cargo,
  /^\s*version\s*=\s*"([^"]+)"\s*$/m,
  'native remote-host package version',
);
const gradleContractPath = capture(
  gradle,
  /releaseContractFile\s*=\s*rootProject\.file\('([^']+)'\)/,
  'Android release contract path',
);
const sharedProtocolVersion = Number(capture(
  remoteProtocol,
  /REMOTE_PROTOCOL_VERSION\s*=\s*(\d+)/,
  'shared remote protocol version',
));

assert(rootPackage.version === contract.version, 'package.json version differs from release/version.json.');
assert(
  mobilePackage.version === contract.version,
  'mobile/package.json version differs from release/version.json.',
);
assert(cargoVersion === contract.version, 'native/remote-host/Cargo.toml version differs from release/version.json.');
assert(
  gradleContractPath === '../../release/version.json',
  'Android must read ../../release/version.json as its version source.',
);
assert(
  sharedProtocolVersion === contract.protocolVersion,
  'src/shared/remote-protocol.ts differs from release/version.json protocolVersion.',
);

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(contract)}\n`);
} else {
  process.stdout.write(
    `Verified EZTerminal ${contract.version}, Android versionCode ${contract.androidVersionCode}, protocol v${contract.protocolVersion}.\n`,
  );
}
