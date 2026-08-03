import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const SIGNPATH_CONFIGURATION_NAMES = Object.freeze([
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORGANIZATION_ID',
  'SIGNPATH_PROJECT_SLUG',
  'SIGNPATH_SIGNING_POLICY_SLUG',
  'SIGNPATH_WINDOWS_PAYLOAD_CONFIGURATION_SLUG',
  'SIGNPATH_WINDOWS_INSTALLER_CONFIGURATION_SLUG',
]);

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveWindowsSigningMode(policyMode, environment) {
  if (policyMode !== 'unsigned' && policyMode !== 'signpath') {
    throw new Error(`Unsupported Windows signing policy mode: ${String(policyMode)}`);
  }

  const present = SIGNPATH_CONFIGURATION_NAMES.filter((name) => configured(environment[name]));
  const missing = SIGNPATH_CONFIGURATION_NAMES.filter((name) => !configured(environment[name]));

  if (policyMode === 'unsigned') {
    if (present.length > 0) {
      throw new Error(
        'release/version.json still selects unsigned Windows releases, but SignPath '
          + `configuration is present: ${present.join(', ')}. Change windowsSigningMode to `
          + 'signpath in a reviewed commit only after all SignPath settings are ready.',
      );
    }
    return 'unsigned';
  }

  if (missing.length > 0) {
    throw new Error(
      'Signed Windows releases are required, but SignPath configuration is incomplete: '
        + missing.join(', '),
    );
  }
  return 'signpath';
}

export function releaseWindowsSigningMode(filePath = path.resolve('release', 'version.json')) {
  const contract = JSON.parse(readFileSync(filePath, 'utf8'));
  return contract.windowsSigningMode;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const mode = resolveWindowsSigningMode(releaseWindowsSigningMode(), process.env);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required in the release workflow.');
  appendFileSync(outputPath, `mode=${mode}\n`, 'utf8');
  console.log(
    mode === 'signpath'
      ? 'Windows release mode: SignPath signing is required.'
      : 'Windows release mode: unsigned maintenance release; no SignPath configuration is present.',
  );
}
