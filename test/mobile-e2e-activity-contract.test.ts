import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseAppCameraClientActive } from '../mobile/e2e/camera-state.ts';
import {
  parseDump,
  parseResumedActivity,
  shortPressOnce,
  submitConnectionOnce,
  tapTestIdOnce,
} from '../mobile/e2e/lib.ts';

describe('Android resumed-activity parser', () => {
  it('accepts the API 29 mResumedActivity colon format', () => {
    const output = [
      'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
      '  mResumedActivity: ActivityRecord{abc u0 com.android.documentsui/.picker.PickActivity t42}',
    ].join('\n');

    expect(parseResumedActivity(output)).toContain('com.android.documentsui/.picker.PickActivity');
  });

  it('accepts the modern topResumedActivity equals format', () => {
    const output = '  topResumedActivity=ActivityRecord{def u0 com.ezterminal.remote/.MainActivity t7}';

    expect(parseResumedActivity(output)).toContain('com.ezterminal.remote/.MainActivity');
  });

  it('accepts an unprefixed ResumedActivity colon format', () => {
    const output = ' ResumedActivity:ActivityRecord{ghi u0 com.android.documentsui/.picker.PickActivity t9}';

    expect(parseResumedActivity(output)).toContain('com.android.documentsui/.picker.PickActivity');
  });

  it('returns an empty string when no resumed activity is reported', () => {
    expect(parseResumedActivity('mFocusedActivity=null')).toBe('');
  });

  it('retains stable system resource and package identifiers from UI dumps', () => {
    const [node] = parseDump(
      '<node text="Downloads" resource-id="android:id/title" '
      + 'class="android.widget.TextView" package="com.android.documentsui" '
      + 'content-desc="" clickable="false" bounds="[176,424][748,477]" />',
    );

    expect(node).toMatchObject({
      text: 'Downloads',
      resourceId: 'android:id/title',
      packageName: 'com.android.documentsui',
    });
  });

  it('keeps the release connection gate to one product submission', () => {
    const implementation = submitConnectionOnce.toString();
    expect(implementation.match(/tapTestId\(['"]connect-submit['"]\)/g)).toHaveLength(1);
    expect(implementation).not.toMatch(/\b(?:for|while)\s*\(/);
    expect(implementation).toContain('only allowed attempt');
    expect(implementation).toContain('assertColdConnectionUsedOneSocket');

    const e2eSources = ['lib.ts', 'parity.ts', 'smoke.ts', 'apk-stabilization.ts', 'theme-effects-font.ts']
      .map((name) => readFileSync(new URL(`../mobile/e2e/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    expect(e2eSources.match(/tapTestId\(['"]connect-submit['"]\)/g)).toHaveLength(1);
  });

  it('keeps each smoke command behind one fail-closed native injection', () => {
    const smoke = readFileSync(
      new URL('../mobile/e2e/smoke.ts', import.meta.url),
      'utf8',
    );
    const lib = readFileSync(
      new URL('../mobile/e2e/lib.ts', import.meta.url),
      'utf8',
    );
    const submissionStart = smoke.indexOf('async function submitCommandThroughNativeTap');
    const submissionEnd = smoke.indexOf(
      'async function logTerminalSubmissionDiagnostics',
      submissionStart,
    );
    const submission = submissionStart >= 0 && submissionEnd > submissionStart
      ? smoke.slice(submissionStart, submissionEnd)
      : undefined;

    expect(submission).toBeDefined();
    expect(submission?.match(/tapTestIdOnce\(['"]btn-run['"]\)/g)).toHaveLength(1);
    expect(submission).not.toMatch(/tapTestId\(['"]btn-run['"]\)/);
    expect(submission).toContain('waitForCommandSubmissionAcknowledgement');
    expect(submission).toContain('expectedViewport');
    expect(smoke).toContain('viewportMatchesBaseline(state, expectedViewport)');
    expect(smoke).toContain("state.activeElement?.testId === 'cmd-input'");
    expect(smoke).toContain('terminalViewportBaseline');

    const singleTapImplementation = tapTestIdOnce.toString();
    expect(singleTapImplementation).not.toMatch(/\b(?:for|while)\s*\(/);
    expect(singleTapImplementation).toContain('tapWebViewElementGeometry');
    expect(singleTapImplementation).toContain('forceRefreshDeviceGeometry: true');
    expect(singleTapImplementation).toMatch(/gesture:\s*["']short-press["']/);
    expect(singleTapImplementation).toContain('visibleTestIdExpression(testId)');
    expect(singleTapImplementation).not.toContain('visibleTestIdExpression(testId, true)');

    const shortPressImplementation = shortPressOnce.toString();
    expect(shortPressImplementation).not.toMatch(/\b(?:for|while)\s*\(/);
    expect(shortPressImplementation.match(/\brunAdb\(/g)).toHaveLength(1);
    expect(shortPressImplementation.replace(/\s/g, '').replace(/"/g, "'")).toContain(
      "'shell','input','touchscreen','swipe',String(p.x),String(p.y),String(p.x),String(p.y),'80'",
    );

    const geometryTapStart = lib.indexOf(
      'async function tapWebViewElementGeometry',
    );
    const geometryTapEnd = lib.indexOf(
      '/** Locates a DOM test id through CDP',
      geometryTapStart,
    );
    const geometryTap = geometryTapStart >= 0 && geometryTapEnd > geometryTapStart
      ? lib.slice(geometryTapStart, geometryTapEnd)
      : undefined;
    expect(geometryTap).toBeDefined();
    expect(geometryTap).not.toMatch(/\b(?:for|while)\s*\(/);
    expect(geometryTap?.match(/\bawait tap\(/g)).toHaveLength(1);
    expect(geometryTap?.match(/\bawait shortPressOnce\(/g)).toHaveLength(1);

    const nativeTapStart = lib.indexOf('export async function tap(p: Point)');
    const nativeTapEnd = lib.indexOf('interface CdpTarget', nativeTapStart);
    const nativeTap = nativeTapStart >= 0 && nativeTapEnd > nativeTapStart
      ? lib.slice(nativeTapStart, nativeTapEnd)
      : undefined;
    expect(nativeTap).toBeDefined();
    expect(nativeTap).not.toMatch(/\b(?:for|while)\s*\(/);
    expect(nativeTap?.match(/\brunAdb\(/g)).toHaveLength(1);
    expect(nativeTap).toContain("['shell', 'input', 'tap'");
  });

  it('binds the single-attempt policy into the protected RC report', () => {
    const verifier = readFileSync(
      new URL('../scripts/verify-release-candidate.ps1', import.meta.url),
      'utf8',
    );
    const releaseWorkflow = readFileSync(
      new URL('../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );
    const releaseStager = readFileSync(
      new URL('../scripts/stage-release-artifacts.ps1', import.meta.url),
      'utf8',
    );
    expect(verifier).toContain('mobileConnectionAttemptsPerScenario = 1');
    expect(verifier).toContain('mobileSocketAttemptsBeforeInitialAuth = 1');
    expect(verifier).toContain("mobileTransport = 'adb-reverse-loopback'");
    expect(verifier).toContain('mobileRemotePort = 17420');
    expect(verifier).toContain("emulatorBootMode = 'cold-no-snapshot'");
    expect(verifier).toContain("$env:EZTERMINAL_REMOTE_VPN_INTERFACE = '127.0.0.1'");
    expect(verifier).toContain("$env:EZTERMINAL_MOBILE_E2E_HOST_URL = 'ws://127.0.0.1:17420'");
    expect(verifier).toContain("'-no-snapshot-load', '-no-snapshot-save'");
    expect(verifier).toContain('function Invoke-AdbBounded');
    expect(verifier).toContain('$EmulatorProcess.HasExited');
    expect(verifier).not.toContain('wait-for-device');
    expect(releaseWorkflow).toContain('[int]$rcReport.mobileConnectionAttemptsPerScenario -ne 1');
    expect(releaseWorkflow).toContain('[int]$rcReport.mobileSocketAttemptsBeforeInitialAuth -ne 1');
    expect(releaseWorkflow).toContain("[string]$rcReport.mobileTransport -ne 'adb-reverse-loopback'");
    expect(releaseWorkflow).toContain('[int]$rcReport.mobileRemotePort -ne 17420');
    expect(releaseWorkflow).toContain("[string]$rcReport.emulatorBootMode -ne 'cold-no-snapshot'");
    expect(releaseWorkflow).toMatch(
      /foreach\s*\(\$requiredLane\s+in\s+@\([\s\S]*?'qr-scanner'[\s\S]*?\)\)/u,
    );
    expect(releaseStager).toContain('[int]$localRcReport.mobileSocketAttemptsBeforeInitialAuth');
    expect(releaseStager).toContain('[string]$localRcReport.mobileTransport');
    expect(releaseStager).toContain('[int]$localRcReport.mobileRemotePort');
    expect(releaseStager).toContain("[string]$localRcReport.emulatorBootMode");
  });
});

describe('Android CameraService client parser', () => {
  const dump = (activeClients: string): string => [
    'Camera service events log:',
    'Number of camera devices: 2',
    'Number of normal camera devices: 2',
    'Active Camera Clients:',
    activeClients,
    'Allowed user IDs: 0',
  ].join('\n');

  it('distinguishes the exact app client from an inactive camera service', () => {
    expect(parseAppCameraClientActive(
      dump('[com.ezterminal.remote (PID 4123)]'),
      'com.ezterminal.remote',
    )).toBe(true);
    expect(parseAppCameraClientActive(dump('[]'), 'com.ezterminal.remote')).toBe(false);
  });

  it('does not accept a longer package name with the app id as a prefix', () => {
    expect(parseAppCameraClientActive(
      dump('[com.ezterminal.remote.test (PID 4123)]'),
      'com.ezterminal.remote',
    )).toBe(false);
  });

  it.each([
    '!! No camera HAL available !!',
    "Can't find service: media.camera",
    [
      '!! CameraService may be deadlocked !!',
      'Number of camera devices: 2',
      'Active Camera Clients:',
      '[]',
      'Allowed user IDs: 0',
    ].join('\n'),
    'Number of camera devices: 0\nActive Camera Clients:\n[]\nAllowed user IDs: 0',
    'Number of camera devices: 2\nAllowed user IDs: 0',
  ])('rejects unobservable CameraService evidence: %s', (cameraDump) => {
    expect(() => parseAppCameraClientActive(cameraDump, 'com.ezterminal.remote')).toThrow();
  });
});
