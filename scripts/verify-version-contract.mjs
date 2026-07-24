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
const apkVerifier = await readFile(resolve(root, 'mobile/android/scripts/verify-apk.ps1'), 'utf8');
const verificationMetadata = await readFile(
  resolve(root, 'mobile/android/gradle/verification-metadata.xml'),
  'utf8',
);
const releaseWorkflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
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
const defaultApkVersion = capture(
  apkVerifier,
  /\[string\]\$ExpectedVersionName\s*=\s*'([^']+)'/,
  'APK verifier default versionName',
);
const defaultApkVersionCode = Number(capture(
  apkVerifier,
  /\[int\]\$ExpectedVersionCode\s*=\s*(\d+)/,
  'APK verifier default versionCode',
));
const aapt2Metadata = capture(
  verificationMetadata,
  /<component group="com\.android\.tools\.build" name="aapt2" version="[^"]+">([\s\S]*?)<\/component>/,
  'AAPT2 dependency verification metadata',
);

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
assert(
  defaultApkVersion === contract.version,
  'mobile/android/scripts/verify-apk.ps1 default versionName differs from release/version.json.',
);
assert(
  defaultApkVersionCode === contract.androidVersionCode,
  'mobile/android/scripts/verify-apk.ps1 default versionCode differs from release/version.json.',
);
for (const platform of ['linux', 'windows']) {
  assert(
    new RegExp(
      `<artifact name="aapt2-[^"]+-${platform}\\.jar">\\s*` +
      '<sha256 value="[0-9a-f]{64}" origin="[^"]+"\\/>\\s*<\\/artifact>',
    ).test(aapt2Metadata),
    `AAPT2 dependency verification metadata is missing a trusted ${platform} artifact.`,
  );
}

const releaseNotesPath = `docs/release/release-notes-${contract.version}.md`;
const validationPolicyPath = `docs/release/validation-policy-${contract.version}.md`;
await Promise.all([
  readFile(resolve(root, releaseNotesPath), 'utf8'),
  readFile(resolve(root, validationPolicyPath), 'utf8'),
]);
assert(
  releaseWorkflow.includes(`body_path: ${releaseNotesPath}`),
  `.github/workflows/release.yml does not publish ${releaseNotesPath}.`,
);
const nativeHostE2eBuildIndex = releaseWorkflow.search(
  /^[ \t]*- name: Build native remote host for desktop E2E\r?\n[ \t]+run: pnpm build:remote-host[ \t]*$/m,
);
const desktopE2eIndex = releaseWorkflow.search(
  /^[ \t]*- name: Desktop end-to-end tests[ \t]*$/m,
);
assert(
  nativeHostE2eBuildIndex >= 0,
  '.github/workflows/release.yml must build the native remote host for desktop E2E.',
);
assert(
  desktopE2eIndex > nativeHostE2eBuildIndex,
  '.github/workflows/release.yml must build the native remote host before desktop E2E.',
);

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(contract)}\n`);
} else {
  process.stdout.write(
    `Verified EZTerminal ${contract.version}, Android versionCode ${contract.androidVersionCode}, protocol v${contract.protocolVersion}.\n`,
  );
}
