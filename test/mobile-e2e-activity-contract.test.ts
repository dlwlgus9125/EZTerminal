import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseDump, parseResumedActivity, submitConnectionOnce } from '../mobile/e2e/lib.ts';

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
    expect(releaseWorkflow).toContain('[int]$rcReport.mobileConnectionAttemptsPerScenario -ne 1');
    expect(releaseWorkflow).toContain('[int]$rcReport.mobileSocketAttemptsBeforeInitialAuth -ne 1');
    expect(releaseWorkflow).toContain("[string]$rcReport.mobileTransport -ne 'adb-reverse-loopback'");
    expect(releaseWorkflow).toContain('[int]$rcReport.mobileRemotePort -ne 17420');
    expect(releaseWorkflow).toContain("[string]$rcReport.emulatorBootMode -ne 'cold-no-snapshot'");
    expect(releaseStager).toContain('[int]$localRcReport.mobileSocketAttemptsBeforeInitialAuth');
    expect(releaseStager).toContain('[string]$localRcReport.mobileTransport');
    expect(releaseStager).toContain('[int]$localRcReport.mobileRemotePort');
    expect(releaseStager).toContain("[string]$localRcReport.emulatorBootMode");
  });
});
