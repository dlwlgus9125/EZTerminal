import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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

function findExpressionsInShellSteps(source) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  let blockIndent = null;

  for (const [index, line] of lines.entries()) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (
      blockIndent !== null
      && trimmed.length > 0
      && indent <= blockIndent
    ) {
      blockIndent = null;
    }
    if (blockIndent !== null && line.includes('${{')) {
      findings.push(index + 1);
    }
    if (/^\s*run:\s*[|>][+-]?\s*$/.test(line)) {
      blockIndent = indent;
    } else if (/^\s*run:.*\$\{\{/.test(line)) {
      findings.push(index + 1);
    }
  }

  return findings;
}

const contract = await readJson('release/version.json');
const rootPackage = await readJson('package.json');
const mobilePackage = await readJson('mobile/package.json');
const cargo = await readFile(resolve(root, 'native/remote-host/Cargo.toml'), 'utf8');
const cargoLock = await readFile(resolve(root, 'native/remote-host/Cargo.lock'), 'utf8');
const gradle = await readFile(resolve(root, 'mobile/android/app/build.gradle'), 'utf8');
const apkVerifier = await readFile(resolve(root, 'mobile/android/scripts/verify-apk.ps1'), 'utf8');
const verificationMetadata = await readFile(
  resolve(root, 'mobile/android/gradle/verification-metadata.xml'),
  'utf8',
);
const releaseWorkflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
const ciWorkflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const windowsSigningModeResolver = await readFile(
  resolve(root, 'scripts/resolve-windows-signing-mode.mjs'),
  'utf8',
);
const playwrightConfig = await readFile(resolve(root, 'playwright.config.ts'), 'utf8');
const releaseStager = await readFile(
  resolve(root, 'scripts/stage-release-artifacts.ps1'),
  'utf8',
);
const remoteProtocol = await readFile(resolve(root, 'src/shared/remote-protocol.ts'), 'utf8');
const nativeDesktopProtocol = await readFile(
  resolve(root, 'src/main/native-desktop-protocol.ts'),
  'utf8',
);
const nativeHostLib = await readFile(resolve(root, 'native/remote-host/src/lib.rs'), 'utf8');
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
const roadmap = await readFile(resolve(root, 'docs/ROADMAP.md'), 'utf8');
const appHeaderStory = await readFile(
  resolve(root, 'src/renderer/workbench/AppHeader.stories.tsx'),
  'utf8',
);
const releaseVerifier = await readFile(
  resolve(root, 'scripts/verify-release-candidate.ps1'),
  'utf8',
);
const localCandidateBuilder = await readFile(
  resolve(root, 'scripts/build-local-release-candidate.ps1'),
  'utf8',
);
const ephemeralSigningProcess = await readFile(
  resolve(root, 'scripts/invoke-ephemeral-signing-process.ps1'),
  'utf8',
);
const ephemeralSigningJob = await readFile(
  resolve(root, 'scripts/ephemeral-signing-job.cs'),
  'utf8',
);
const androidGradleSigningChild = await readFile(
  resolve(root, 'scripts/invoke-android-gradle-signing-child.ps1'),
  'utf8',
);
const releaseSourceEvidenceVerifier = await readFile(
  resolve(root, 'scripts/verify-release-source-evidence.mjs'),
  'utf8',
);
const releaseEvidenceBundle = await readFile(
  resolve(root, 'scripts/release-evidence-bundle.ps1'),
  'utf8',
);
const mobileReleaseSoak = await readFile(
  resolve(root, 'mobile/e2e/release-soak.ts'),
  'utf8',
);
const mobileHandoffSurfaces = await readFile(
  resolve(root, 'mobile/e2e/handoff-surfaces.ts'),
  'utf8',
);
const mobileQrScanner = await readFile(
  resolve(root, 'mobile/e2e/qr-scanner.ts'),
  'utf8',
);
const mobileCameraState = await readFile(
  resolve(root, 'mobile/e2e/camera-state.ts'),
  'utf8',
);
const mobileE2eLibrary = await readFile(resolve(root, 'mobile/e2e/lib.ts'), 'utf8');

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
assert(
  contract.validationProfile === 'full'
    || contract.validationProfile === 'functional-hotfix',
  'release/version.json validationProfile must be full or functional-hotfix.',
);
assert(
  contract.windowsSigningMode === 'unsigned'
    || contract.windowsSigningMode === 'signpath',
  'release/version.json windowsSigningMode must be unsigned or signpath.',
);

const cargoVersion = capture(
  cargo,
  /^\s*version\s*=\s*"([^"]+)"\s*$/m,
  'native remote-host package version',
);
const cargoLockVersion = capture(
  cargoLock,
  /\[\[package\]\]\s*name\s*=\s*"ezterminal-remote-host"\s*version\s*=\s*"([^"]+)"/m,
  'native remote-host lockfile package version',
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
const nativeDesktopProtocolVersion = Number(capture(
  nativeDesktopProtocol,
  /NATIVE_DESKTOP_PROTOCOL_VERSION\s*=\s*(\d+)/,
  'Electron native desktop protocol version',
));
const nativeHostProtocolVersion = Number(capture(
  nativeHostLib,
  /NATIVE_PROTOCOL_VERSION\s*:\s*u16\s*=\s*(\d+)/,
  'Rust native desktop protocol version',
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
  rootPackage.engines?.node === '>=22.12 <25',
  'package.json must match Electron and the direct TypeScript E2E runtime Node range.',
);
assert(
  mobilePackage.version === contract.version,
  'mobile/package.json version differs from release/version.json.',
);
assert(cargoVersion === contract.version, 'native/remote-host/Cargo.toml version differs from release/version.json.');
assert(
  cargoLockVersion === contract.version,
  'native/remote-host/Cargo.lock version differs from release/version.json.',
);
assert(
  gradleContractPath === '../../release/version.json',
  'Android must read ../../release/version.json as its version source.',
);
assert(
  sharedProtocolVersion === contract.protocolVersion,
  'src/shared/remote-protocol.ts differs from release/version.json protocolVersion.',
);
assert(
  nativeDesktopProtocolVersion === nativeHostProtocolVersion,
  'Electron and Rust native desktop protocol versions differ.',
);
assert(
  defaultApkVersion === contract.version,
  'mobile/android/scripts/verify-apk.ps1 default versionName differs from release/version.json.',
);
assert(
  defaultApkVersionCode === contract.androidVersionCode,
  'mobile/android/scripts/verify-apk.ps1 default versionCode differs from release/version.json.',
);
assert(
  readme.includes(`release-v${contract.version}-brightgreen`),
  'README.md release badge differs from release/version.json.',
);
assert(
  readme.includes(
    `EZTerminal-Android-${contract.version}-vc${contract.androidVersionCode}.apk`,
  ),
  'README.md Android artifact name differs from release/version.json.',
);
assert(
  readme.includes(
    `[${contract.version} validation policy]` +
      `(docs/release/validation-policy-${contract.version}.md)`,
  ),
  'README.md validation-policy link differs from release/version.json.',
);
const escapedVersion = contract.version.replaceAll('.', '\\.');
assert(
  new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog),
  'CHANGELOG.md is missing a dated section for release/version.json.',
);
assert(
  appHeaderStory.includes(`appVersion="${contract.version}"`),
  'The current AppHeader Storybook release fixture differs from release/version.json.',
);
assert(
  new RegExp(
    `^> Current for the \\*\\*v${escapedVersion} release candidate\\*\\* `
      + '\\(\\d{4}-\\d{2}-\\d{2}\\)\\.$',
    'm',
  ).test(roadmap)
    && roadmap.includes(
      `docs/release/validation-policy-${contract.version}.md`,
    ),
  'docs/ROADMAP.md current release marker or validation-policy link differs from release/version.json.',
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
const [releaseNotes, validationPolicy] = await Promise.all([
  readFile(resolve(root, releaseNotesPath), 'utf8'),
  readFile(resolve(root, validationPolicyPath), 'utf8'),
]);
for (const [label, document] of [
  ['release notes', releaseNotes],
  ['validation policy', validationPolicy],
]) {
  assert(
    document.includes(contract.version),
    `${label} does not identify release/version.json version.`,
  );
  assert(
    new RegExp(`protocol(?:Version| version|:)?[^\\n]{0,24}(?:v)?${contract.protocolVersion}`, 'i')
      .test(document),
    `${label} does not identify release/version.json protocolVersion.`,
  );
  assert(
    new RegExp(`versionCode[^\\n]{0,24}${contract.androidVersionCode}`, 'i').test(document),
    `${label} does not identify release/version.json androidVersionCode.`,
  );
}
assert(
  new RegExp(
    `validation profile[^\\n]{0,24}${contract.validationProfile}`,
    'i',
  ).test(validationPolicy),
  'validation policy does not identify release/version.json validationProfile.',
);
assert(
  releaseWorkflow.includes(
    'release_notes_path=docs/release/release-notes-$env:EZTERMINAL_VERSION.md',
  )
    && releaseWorkflow.includes(
      'body_path: release-source/${{ needs.release.outputs.release_notes_path }}',
    ),
  `.github/workflows/release.yml does not bind publication to ${releaseNotesPath}.`,
);
assert(
  releaseWorkflow.includes('RELEASE_VALIDATION_PROFILE')
    && releaseWorkflow.includes('functional-hotfix'),
  '.github/workflows/release.yml does not enforce the release validation profile.',
);
assert(
  releaseStager.includes("[ValidateSet('candidate', 'release')]")
    && releaseStager.includes('validationProfile = $ValidationProfile')
    && releaseStager.includes('protocolVersion = [int]$versionContract.protocolVersion'),
  'scripts/stage-release-artifacts.ps1 does not record the release validation profile.',
);
assert(
  !releaseWorkflow.includes('ProtocolVersion = 2')
    && !releaseStager.includes('[int]$ProtocolVersion = 2'),
  'Release staging must not duplicate a hard-coded remote protocol version.',
);
for (const [label, source] of [
  ['CI workflow', ciWorkflow],
  ['release workflow', releaseWorkflow],
  ['local RC verifier', releaseVerifier],
]) {
  assert(
    source.includes('guard:approval-privacy') && source.includes('guard:pairing-offline'),
    `${label} does not run both handoff security guards.`,
  );
}
assert(
  releaseVerifier.includes("e2e:handoff-surfaces"),
  'Local RC verifier does not include the mobile handoff-surface device lane.',
);
assert(
  mobilePackage.scripts?.['e2e:qr-scanner']
    === 'node --experimental-strip-types e2e/qr-scanner.ts',
  'mobile/package.json does not expose the QR scanner device lane.',
);
for (const [name, command] of Object.entries(mobilePackage.scripts ?? {})) {
  if (!name.startsWith('e2e:')) continue;
  assert(
    /^node --experimental-strip-types e2e\/[a-z0-9-]+\.ts(?:\s|$)/u.test(command),
    `mobile/package.json ${name} does not explicitly enable Node TypeScript stripping.`,
  );
}
assert(
  releaseVerifier.includes("e2e:qr-scanner"),
  'Local RC verifier does not include the QR scanner device lane.',
);
for (const marker of [
  "tapTestId('connect-scan-qr')",
  'MIN_NON_BLACK_PIXEL_RATIO',
  'topmostAtCenter',
  'currentTime < sample.currentTime + 0.1',
  'parseAppCameraClientActive',
  'waitForResumedActivity',
  "['shell', 'input', 'keyevent', '3']",
  'QR SCANNER CAMERA ACTIVE IN BACKGROUND',
  'reopened preview',
  "['shell', 'input', 'keyevent', '4']",
  'trigger focus restored',
]) {
  assert(
    mobileQrScanner.includes(marker),
    `The QR scanner device lane omits required behavior: ${marker}.`,
  );
}
assert(
  releaseVerifier.includes("'-camera-back', 'emulated'")
    && releaseVerifier.includes("'-legacy-fake-camera'")
    && releaseVerifier.includes("'-prop', 'qemu.sf.fake_camera=back'")
    && releaseVerifier.includes('Assert-EmulatedCameraAvailable $serial $Api'),
  'Local RC verifier does not provision and verify the emulator camera.',
);
assert(
  releaseVerifier.includes('function Invoke-AdbBounded')
    && releaseVerifier.includes('$EmulatorProcess.HasExited')
    && !releaseVerifier.includes('wait-for-device'),
  'Local RC verifier does not bound adb boot probes and emulator early exit.',
);
assert(
  mobileCameraState.includes('Number of camera devices:')
    && mobileCameraState.includes('Active Camera Clients:')
    && mobileCameraState.includes('Allowed user IDs:')
    && mobileE2eLibrary.includes('ADB_COMMAND_TIMEOUT_MS')
    && mobileE2eLibrary.includes('timeout: Math.max(1, Math.floor(timeoutMs))'),
  'Mobile QR evidence does not fail closed on unobservable CameraService or adb state.',
);
for (const [label, source] of [
  ['release staging', releaseStager],
  ['release workflow', releaseWorkflow],
]) {
  assert(
    /foreach\s*\(\$requiredLane\s+in\s+@\([\s\S]*?'qr-scanner'[\s\S]*?\)\)/u
      .test(source),
    `${label} does not require QR scanner device evidence.`,
  );
}
assert(
  mobileHandoffSurfaces.includes(
    'launchDesktop({ cwd: gitFixture.directory })',
  )
    && mobileHandoffSurfaces.includes('const gitFixture = createGitFixture()')
    && mobileHandoffSurfaces.includes(
      'if (line.includes(gitFixture.branch)) break;',
    )
    && !mobileHandoffSurfaces.includes('SKIPPED')
    && !/\bif\s*\(\s*(?:expectedBranch|branch|isGitWorkTree)\b/u
      .test(mobileHandoffSurfaces),
  'The handoff-surface lane must prove Git status from an independent branch '
    + 'fixture without a detached-HEAD skip branch.',
);
assert(
  releaseVerifier.includes('EZTERMINAL_RUN_RELEASE_PERFORMANCE')
    && releaseVerifier.includes('EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC'),
  'Non-performance local RC verification must reject inherited performance modes.',
);
const performanceOptInVariables = [
  ...playwrightConfig.matchAll(
    /process\.env\.(EZTERMINAL_RUN_[A-Z0-9_]*PERFORMANCE[A-Z0-9_]*)/g,
  ),
].map((match) => match[1]);
assert(
  performanceOptInVariables.length > 0,
  'playwright.config.ts does not expose an auditable performance opt-in.',
);
for (const variable of new Set(performanceOptInVariables)) {
  assert(
    releaseVerifier.includes(`$env:${variable}`),
    `Non-performance local RC verification does not reject inherited ${variable}.`,
  );
}
assert(
  localCandidateBuilder.includes("-ArtifactStage candidate")
    && !localCandidateBuilder.includes('RunPerformanceMeasurement')
    && localCandidateBuilder.includes(
      "invoke-ephemeral-signing-process.ps1",
    )
    && localCandidateBuilder.includes(
      "invoke-android-gradle-signing-child.ps1",
    )
    && localCandidateBuilder.includes('Invoke-EphemeralSigningProcess')
    && localCandidateBuilder.includes(
      '-DiagnosticLogPath $diagnosticLogPath',
    )
    && localCandidateBuilder.includes("publicationEligible -ne $false")
    && localCandidateBuilder.includes('-MobileSoakReportPath $soakReportPath')
    && localCandidateBuilder.includes(
      "sourceEvidence.mobileSoakReportSha256 -cnotmatch",
    ),
  'The default local RC wrapper must stage only a publication-ineligible candidate.',
);
assert(
  ephemeralSigningProcess.includes('Invoke-EphemeralSigningProcess')
    && ephemeralSigningProcess.includes('StartSuspendedAndAssign')
    && ephemeralSigningProcess.includes('$process.WaitForExit(100)')
    && ephemeralSigningProcess.includes('$CancellationToken.IsCancellationRequested')
    && ephemeralSigningProcess.includes('$job.TerminateAndWait(30000)')
    && ephemeralSigningProcess.includes('MaxDiagnosticBytes = 262144')
    && ephemeralSigningProcess.includes('[android-signing]')
    && ephemeralSigningProcess.includes(
      '$StartInfo.EnvironmentVariables.Remove($name)',
    )
    && ephemeralSigningProcess.includes('$EphemeralEnvironment.Clear()'),
  'Local Android signing must kill its process tree and clear step-scoped secrets '
    + 'on success, failure, timeout, or cancellation.',
);
assert(
  ephemeralSigningJob.includes('CreateSuspended = 0x00000004')
    && ephemeralSigningJob.includes(
      'JobObjectLimitKillOnJobClose = 0x00002000',
    )
    && ephemeralSigningJob.includes('StartSuspendedAndAssign')
    && ephemeralSigningJob.includes('AssignProcessToJobObject')
    && ephemeralSigningJob.includes('TerminateJobObject')
    && /CreateProcess\([\s\S]{0,500}?false,\s*creationFlags/u
      .test(ephemeralSigningJob)
    && !ephemeralSigningJob.includes('Process.Start('),
  'The Windows signing launcher must bind a suspended process to a '
    + 'kill-on-close Job Object before resuming it, without broad handle inheritance.',
);
assert(
  androidGradleSigningChild.includes(
    'EZTERMINAL_SIGNING_DIAGNOSTIC_LOG',
  )
    && androidGradleSigningChild.includes(
      'EZTERMINAL_SIGNING_MAX_DIAGNOSTIC_BYTES',
    )
    && androidGradleSigningChild.includes("'[REDACTED]'")
    && androidGradleSigningChild.includes('$diagnosticTruncated')
    && androidGradleSigningChild.includes('--stacktrace 2>&1'),
  'Android signing diagnostics must remain bounded and redact signing values.',
);
assert(
  releaseWorkflow.includes("ArtifactStage = 'release'")
    && releaseWorkflow.includes("[string]$rcReport.releaseStage -ne 'release'")
    && releaseWorkflow.includes("[string]$performance.status -ne 'passed'")
    && releaseWorkflow.includes('ReleaseAssetsPath = $env:RELEASE_ASSETS_PATH')
    && releaseWorkflow.includes('${{ env.RELEASE_ASSETS_PATH }}/*')
    && releaseWorkflow.includes('files: publish-assets/*')
    && !releaseWorkflow.includes('path: release-assets/**/*')
    && !releaseWorkflow.includes('files: release-assets/**/*'),
  'The final release workflow must reject pending evidence and publish only exact scoped assets.',
);
assert(
  releaseSourceEvidenceVerifier.includes('assertNoNonFiniteValues')
    && releaseSourceEvidenceVerifier.includes('verify-performance-report.mjs')
    && releaseSourceEvidenceVerifier.includes(
      'mobile soak growth checks do not equal the raw memory-sample calculation',
    )
    && releaseSourceEvidenceVerifier.includes(
      'embedded performance comparison results differ from raw report verification',
    )
    && releaseSourceEvidenceVerifier.includes(
      'mobile soak evidence must not expose a machine-local reportPath',
    ),
  'The shared release source-evidence verifier must reject non-finite or reconstructed evidence.',
);
assert(
  releaseVerifier.includes('verify-release-source-evidence.mjs')
    && releaseVerifier.includes('release-evidence-bundle.ps1')
    && releaseVerifier.includes("'local-rc-evidence.zip'")
    && releaseVerifier.includes("'desktop-performance-baseline.json'")
    && releaseVerifier.includes("'desktop-performance-report.json'")
    && releaseVerifier.includes('base64Length -gt 30000')
    && releaseVerifier.includes('EZTERMINAL_LOCAL_RC_EVIDENCE_SHA256')
    && releaseVerifier.includes('EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64')
    && releaseVerifier.includes('.bundle-verification')
    && releaseVerifier.includes(
      'The approval bundle source evidence failed round-trip validation.',
    )
    && !releaseVerifier.includes('EZTERMINAL_LOCAL_RC_REPORT_BASE64'),
  'The local RC verifier must emit one hash-bound raw-evidence approval bundle.',
);
assert(
  releaseStager.includes("[string]$ArtifactStage = 'candidate'")
    && releaseStager.includes(
      "$ArtifactStage -eq 'release' -and -not $RequireCleanTree",
    )
    && releaseStager.includes('verify-release-source-evidence.mjs')
    && releaseStager.includes("'mobile-soak-report.json'")
    && releaseStager.includes("'desktop-performance-baseline.json'")
    && releaseStager.includes("'desktop-performance-report.json'")
    && releaseStager.includes('approvalBundleSha256'),
  'Release staging must default safe and preserve independently verified raw evidence.',
);
assert(
  releaseEvidenceBundle.includes(
    "'^[A-Za-z0-9][A-Za-z0-9._-]*$'",
  )
    && releaseEvidenceBundle.includes('MaxEntryBytes = 16777216')
    && releaseEvidenceBundle.includes('MaxTotalBytes = 33554432')
    && releaseEvidenceBundle.includes('MaxBase64Characters = 30000')
    && releaseEvidenceBundle.includes('[IO.FileMode]::CreateNew')
    && releaseEvidenceBundle.includes('$actualEntryBytes')
    && releaseEvidenceBundle.includes('$actualTotalBytes')
    && releaseEvidenceBundle.includes('$input.Read(')
    && !releaseEvidenceBundle.includes('$input.CopyTo(')
    && releaseEvidenceBundle.includes(
      'Evidence extraction destination must not already exist',
    )
    && !/^\s*exit(?:\s|$)/m.test(releaseEvidenceBundle),
  'The protected evidence bundle helper is missing its bounded safe-extraction contract.',
);
assert(
  mobileReleaseSoak.includes(
    "path.relative(ROOT, APK_PATH).split(path.sep).join('/')",
  )
    && !mobileReleaseSoak.includes('readonly reportPath: string'),
  'Mobile soak evidence must use a repository-relative APK identity and omit machine-local paths.',
);
const releaseJob = capture(
  releaseWorkflow,
  /^ {2}release:\r?\n([\s\S]*?)^ {2}publish:\r?$/m,
  'release validation/build job',
);
const publishJob = capture(
  releaseWorkflow,
  /^ {2}publish:\r?\n([\s\S]*)$/m,
  'release publish job',
);
const shellExpressionLines = findExpressionsInShellSteps(releaseWorkflow);
assert(
  shellExpressionLines.length === 0,
  'GitHub expressions must enter release shell steps through step-scoped '
    + `environment variables, not inline interpolation (lines: ${
      shellExpressionLines.join(', ')
    }).`,
);
const ciShellExpressionLines = findExpressionsInShellSteps(ciWorkflow);
assert(
  ciShellExpressionLines.length === 0,
  'GitHub expressions must enter CI shell steps through environment variables, '
    + `not inline interpolation (lines: ${ciShellExpressionLines.join(', ')}).`,
);
const releaseJobEnv = capture(
  releaseJob,
  /^ {4}env:\r?\n([\s\S]*?)^ {4}steps:\r?$/m,
  'release job environment block',
);
for (const secretName of [
  'EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64',
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
  'SIGNPATH_API_TOKEN',
]) {
  assert(
    !releaseJobEnv.includes(secretName),
    `.github/workflows/release.yml must not expose ${secretName} at job scope.`,
  );
}
const signedStepConditions = releaseJob.match(
  /^ {8}if: steps\.windows_signing\.outputs\.mode == 'signpath'$/gm,
) ?? [];
assert(
  releaseWorkflow.includes('run: node scripts/resolve-windows-signing-mode.mjs')
    && releaseWorkflow.includes('WINDOWS_SIGNING_MODE: ${{ steps.windows_signing.outputs.mode }}')
    && signedStepConditions.length === 6
    && windowsSigningModeResolver.includes("policyMode === 'unsigned'")
    && windowsSigningModeResolver.includes('present.length > 0')
    && windowsSigningModeResolver.includes('missing.length > 0')
    && releaseStager.includes("$ArtifactStage -eq 'release'")
    && releaseStager.includes('Unsigned Windows releases require the retained uninstaller')
    && publishJob.includes("-notin @('Valid', 'NotSigned')")
    && publishJob.includes("Join-Path 'release-source' 'release/version.json'")
    && publishJob.includes(
      '[string]$windowsAuthenticode.expected -cne $expectedWindowsSignature',
    )
    && publishJob.includes('Invalid unsigned Windows component evidence'),
  'The release workflow must allow only an explicit, fully unconfigured unsigned mode and fail closed after SignPath activation.',
);
assert(
  !releaseWorkflow.includes('EZTERMINAL_LOCAL_RC_REPORT_BASE64')
    && releaseWorkflow.includes(
      'LOCAL_RC_EVIDENCE_BASE64: ${{ secrets.EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64 }}',
    )
    && releaseWorkflow.includes(
      'LOCAL_RC_EVIDENCE_SHA256: ${{ vars.EZTERMINAL_LOCAL_RC_EVIDENCE_SHA256 }}',
    )
    && releaseWorkflow.includes('$env:LOCAL_RC_EVIDENCE_BASE64 = $null')
    && releaseWorkflow.indexOf('$env:LOCAL_RC_EVIDENCE_BASE64 = $null')
      < releaseWorkflow.indexOf('pnpm verify:version')
    && releaseWorkflow.includes('release-evidence-bundle.ps1')
    && releaseWorkflow.includes('verify-release-source-evidence.mjs')
    && releaseWorkflow.includes('Remove protected local RC transport files after staging')
    && releaseWorkflow.includes('Remove protected Android keystore after assembly'),
  'The final workflow must use step-scoped secrets and clean protected transport material early.',
);
const checkoutUses = [
  ...releaseWorkflow.matchAll(
    /uses: actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/g,
  ),
].length;
const nonPersistedCheckouts = [
  ...releaseWorkflow.matchAll(/persist-credentials:\s*false/g),
].length;
const ciCheckoutUses = [
  ...ciWorkflow.matchAll(
    /uses: actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/g,
  ),
].length;
const ciNonPersistedCheckouts = [
  ...ciWorkflow.matchAll(/persist-credentials:\s*false/g),
].length;
assert(
  /^permissions:\r?\n {2}contents: read$/m.test(releaseWorkflow)
    && checkoutUses > 0
    && nonPersistedCheckouts === checkoutUses
    && /permissions:\r?\n {6}contents: read/m.test(releaseJob)
    && !releaseJob.includes('contents: write')
    && !releaseJob.includes('softprops/action-gh-release@')
    && /permissions:\r?\n {6}contents: write/m.test(publishJob),
  'Validation/build jobs must be read-only and must not persist checkout credentials.',
);
assert(
  /^permissions:\r?\n {2}contents: read$/m.test(ciWorkflow)
    && ciCheckoutUses === 3
    && ciNonPersistedCheckouts === ciCheckoutUses,
  'CI must be top-level read-only and disable persisted credentials for every checkout.',
);
assert(
  publishJob.includes('needs: release')
    && publishJob.includes("if: github.event_name == 'push'")
    && publishJob.includes('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c')
    && publishJob.includes('Reverify downloaded manifest and checksums')
    && publishJob.includes('needs.release.outputs.release_sums_sha256')
    && publishJob.includes(
      'Downloaded SHA256SUMS differs from the immutable build-job digest',
    )
    && publishJob.includes('SHA256SUMS does not cover the exact downloaded file set')
    && publishJob.includes('softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65')
    && !publishJob.includes('secrets.')
    && !publishJob.includes('pnpm ')
    && !publishJob.includes('cargo ')
    && !publishJob.includes('gradlew'),
  'The write-scoped publish job must only reverify and draft the downloaded immutable artifact.',
);

const tagName = `v${contract.version}`;
const tagLookup = spawnSync(
  'git',
  ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`],
  { cwd: root, encoding: 'utf8' },
);
if (tagLookup.status === 0) {
  const taggedContractResult = spawnSync(
    'git',
    ['show', `${tagName}:release/version.json`],
    { cwd: root, encoding: 'utf8' },
  );
  assert(
    taggedContractResult.status === 0,
    `${tagName} exists but does not contain release/version.json.`,
  );
  const taggedContract = JSON.parse(taggedContractResult.stdout);
  for (const field of [
    'version',
    'androidVersionCode',
    'protocolVersion',
    'validationProfile',
  ]) {
    assert(
      taggedContract[field] === contract[field],
      `${tagName} is immutable: release/version.json ${field} differs from the tag.`,
    );
  }
} else {
  const tagLookupError = tagLookup.stderr?.trim()
    || tagLookup.error?.message
    || `exit status ${String(tagLookup.status)}`;
  assert(
    tagLookup.status === 1,
    `Could not inspect ${tagName}: ${tagLookupError}`,
  );
}
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
const ciNativeHostE2eBuildIndex = ciWorkflow.search(
  /^[ \t]*- name: Build native remote host for desktop E2E\r?\n[ \t]+run: pnpm build:remote-host[ \t]*$/m,
);
const electronE2eIndex = ciWorkflow.search(
  /^[ \t]*- name: Electron end-to-end tests[ \t]*$/m,
);
assert(
  ciNativeHostE2eBuildIndex >= 0,
  '.github/workflows/ci.yml must build the native remote host for Electron E2E.',
);
assert(
  electronE2eIndex > ciNativeHostE2eBuildIndex,
  '.github/workflows/ci.yml must build the native remote host before Electron E2E.',
);

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(contract)}\n`);
} else {
  process.stdout.write(
    `Verified EZTerminal ${contract.version}, Android versionCode ${contract.androidVersionCode}, protocol v${contract.protocolVersion}.\n`,
  );
}
