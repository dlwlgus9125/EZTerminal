import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  inputOwnerBelongsToReadyApp,
  mapWebViewPointToDevice,
  parseImeTrackerLiveEntryCount,
  parseInputDispatcherTouchOwner,
  parseWebViewDeviceBounds,
  type DeviceBounds,
  type WebViewViewportMetrics,
} from '../mobile/e2e/lib.ts';

function hierarchy(
  frame: DeviceBounds,
  webViewSize: readonly [number, number],
  rootSize: readonly [number, number],
): string {
  const [left, top, right, bottom] = frame;
  const [webViewWidth, webViewHeight] = webViewSize;
  const [rootWidth, rootHeight] = rootSize;
  return [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity com.ezterminal.remote)',
    '    View Hierarchy:',
    `      com.android.internal.policy.DecorView{abc V.E...... 0,0-${rootWidth},${rootHeight}}[MainActivity]`,
    `        android.widget.FrameLayout{def V.E...... ${left},${top}-${right},${bottom}}`,
    `          com.getcapacitor.CapacitorWebView{ghi VFEDHVC.. 0,0-${webViewWidth},${webViewHeight} #7f0800c4 app:id/webview aid=1073741824}`,
  ].join('\n');
}

describe('Android WebView physical geometry', () => {
  it('resolves the API 35 foreground touch owner at the final device point', () => {
    const appWindow = [
      '      6: name=579a5f5 com.ezterminal.remote/com.ezterminal.remote.MainActivity, '
        + 'id=119, displayId=0, inputConfig=0x0, alpha=1, frame=[0,0][1080,2280], '
        + 'globalScale=1, applicationInfo.name=ActivityRecord{18d8657 u0 '
        + 'com.ezterminal.remote/.MainActivity t222}, applicationInfo.token=0x1, '
        + 'touchableRegion=[0,0][1080,2280], ownerPid=3991',
    ].join('');
    const visibleIme = [
      'Input Dispatcher State:',
      '  DispatchEnabled: true',
      '  DispatchFrozen: false',
      '  Display: 0',
      '    Windows:',
      '      5: name=ff1538f InputMethod, id=127, displayId=0, '
        + 'inputConfig=NOT_FOCUSABLE | TRUSTED_OVERLAY, alpha=1, '
        + 'frame=[0,1458][1080,2280], globalScale=1, applicationInfo.name=, '
        + 'applicationInfo.token=<null>, touchableRegion=[0,1458][1080,2280], ownerPid=1280',
      appWindow,
      '  Connections:',
      "    524: channelName='579a5f5 "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + 'status=NORMAL, monitor=false, responsive=true',
    ].join('\n');
    const hiddenIme = visibleIme.replace(
      'inputConfig=NOT_FOCUSABLE | TRUSTED_OVERLAY',
      'inputConfig=NOT_VISIBLE | NOT_FOCUSABLE | TRUSTED_OVERLAY',
    );

    expect(parseInputDispatcherTouchOwner(
      visibleIme,
      { x: 992, y: 1866 },
    )).toMatchObject({
      name: 'ff1538f InputMethod',
      dispatchEnabled: true,
      dispatchFrozen: false,
    });
    const appOwner = parseInputDispatcherTouchOwner(
      hiddenIme,
      { x: 992, y: 1866 },
    );
    expect(appOwner?.applicationName).toContain('com.ezterminal.remote/.MainActivity');
    expect(inputOwnerBelongsToReadyApp(appOwner)).toBe(true);
  });

  it('skips non-owning API 35 handles and fails closed for blocking handles', () => {
    const appWindow = '      4: name=579a5f5 '
      + 'com.ezterminal.remote/com.ezterminal.remote.MainActivity, id=119, '
      + 'displayId=0, inputConfig=0x0, alpha=1, frame=[0,0][1080,2280], '
      + 'globalScale=1, applicationInfo.name=ActivityRecord{18d8657 u0 '
      + 'com.ezterminal.remote/.MainActivity t222}, applicationInfo.token=0x1, '
      + 'touchableRegion=[0,0][1080,2280], ownerPid=3991';
    const dump = (overlayConfig: string, options?: {
      dispatchEnabled?: boolean;
      dispatchFrozen?: boolean;
      overlayName?: string;
    }): string => [
      'Input Dispatcher State:',
      `  DispatchEnabled: ${options?.dispatchEnabled ?? true}`,
      `  DispatchFrozen: ${options?.dispatchFrozen ?? false}`,
      '  Display: 0',
      '    Windows:',
      `      3: name=${options?.overlayName ?? 'InputMethod'}, id=127, displayId=0, `
        + `inputConfig=${overlayConfig}, alpha=1, frame=[0,1458][1080,2280], `
        + 'globalScale=1, applicationInfo.name=, applicationInfo.token=<null>, '
        + 'touchableRegion=[0,1458][1080,2280], ownerPid=1280',
      appWindow,
      '  Connections:',
      "    524: channelName='579a5f5 "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + 'status=NORMAL, monitor=false, responsive=true',
    ].join('\n');
    const point = { x: 992, y: 1866 };

    for (const config of [
      'NOT_VISIBLE | NOT_FOCUSABLE | TRUSTED_OVERLAY',
      'NOT_TOUCHABLE | NOT_FOCUSABLE | TRUSTED_OVERLAY',
      'SPY | TRUSTED_OVERLAY',
    ]) {
      expect(inputOwnerBelongsToReadyApp(
        parseInputDispatcherTouchOwner(dump(config), point),
      )).toBe(true);
    }

    for (const config of [
      'NO_INPUT_CHANNEL',
      'PAUSE_DISPATCHING',
      'DROP_INPUT',
      'DROP_INPUT_IF_OBSCURED',
    ]) {
      const owner = parseInputDispatcherTouchOwner(
        dump(config, { overlayName: 'blocking-overlay' }),
        point,
      );
      expect(owner?.name).toBe('blocking-overlay');
      expect(inputOwnerBelongsToReadyApp(owner)).toBe(false);
    }

    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump('NOT_VISIBLE', { dispatchEnabled: false }),
      point,
    ))).toBe(false);
    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump('NOT_VISIBLE', { dispatchFrozen: true }),
      point,
    ))).toBe(false);
    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump('NOT_VISIBLE').replace('responsive=true', 'responsive=false'),
      point,
    ))).toBe(false);
    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump('NOT_VISIBLE').replace(
        'responsive=true',
        'responsive=false, inputPublisherBlocked=false',
      ),
      point,
    ))).toBe(false);
    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump('NOT_VISIBLE').replace('status=NORMAL', 'status=BROKEN'),
      point,
    ))).toBe(false);
    expect(parseInputDispatcherTouchOwner('malformed dump', point)).toBeNull();
  });

  it('fails closed on reordered modern fields and component-prefix spoofing', () => {
    const point = { x: 992, y: 1866 };
    const reordered = [
      'Input Dispatcher State:',
      '  DispatchEnabled: true',
      '  DispatchFrozen: false',
      '  Display: 0',
      '    Windows:',
      '      1: name=579a5f5 '
        + 'com.ezterminal.remote/com.ezterminal.remote.MainActivity, id=119, '
        + 'displayId=0, alpha=1, inputConfig=NOT_TOUCHABLE, '
        + 'frame=[0,0][1080,2280], globalScale=1, '
        + 'applicationInfo.name=ActivityRecord{18d8657 u0 '
        + 'com.ezterminal.remote/.MainActivity t222}, applicationInfo.token=0x1, '
        + 'touchableRegion=[0,0][1080,2280], ownerPid=3991',
      '  Connections:',
      "    524: channelName='579a5f5 "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + 'status=NORMAL, monitor=false, responsive=true',
    ].join('\n');
    expect(parseInputDispatcherTouchOwner(reordered, point)).toBeNull();

    const spoofed = reordered
      .replace('alpha=1, inputConfig=NOT_TOUCHABLE', 'alpha=1, inputConfig=0x0')
      .replaceAll(
        '579a5f5 com.ezterminal.remote/com.ezterminal.remote.MainActivity',
        'spoofcom.ezterminal.remote/com.ezterminal.remote.MainActivity',
      );
    const spoofedOwner = parseInputDispatcherTouchOwner(spoofed, point);
    expect(spoofedOwner?.name).toBe(
      'spoofcom.ezterminal.remote/com.ezterminal.remote.MainActivity',
    );
    expect(inputOwnerBelongsToReadyApp(spoofedOwner)).toBe(false);
  });

  it('supports the real API 29 dispatcher format and multiple touch regions', () => {
    const output = [
      'Input Dispatcher State:',
      '  DispatchEnabled: true',
      '  DispatchFrozen: false',
      '  Display: 0',
      '    Windows:',
      "      0: name='Window{af4622d u0 NavigationBar0}', displayId=0, "
        + 'portalToDisplayId=-1, paused=false, hasFocus=false, hasWallpaper=false, '
        + 'visible=true, canReceiveKeys=false, flags=0x21840068, type=0x000007e3, '
        + 'layer=0, frame=[0,2148][1080,2280], globalScale=1.000000, '
        + 'windowScale=(1.000000,1.000000), touchableRegion=[0,2148][1080,2280], '
        + 'inputFeatures=0x00000000, ownerPid=2098',
      "      1: name='Window{8d6dc9 u0 "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity}', "
        + 'displayId=0, portalToDisplayId=-1, paused=false, hasFocus=true, '
        + 'hasWallpaper=false, visible=true, canReceiveKeys=true, flags=0x81810120, '
        + 'type=0x00000001, layer=0, frame=[0,0][1080,2280], globalScale=1.000000, '
        + 'windowScale=(1.000000,1.000000), '
        + 'touchableRegion=[0,0][500,2280]|[500,0][1080,2280], '
        + 'inputFeatures=0x00000000, ownerPid=5042',
      '  Connections:',
      "    1: channelName='8d6dc9 "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + "windowName='8d6dc9 "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + 'status=NORMAL, monitor=false, inputPublisherBlocked=false',
    ].join('\n');

    const owner = parseInputDispatcherTouchOwner(
      output,
      { x: 992, y: 1866 },
    );
    expect(owner).toMatchObject({
      name: 'Window{8d6dc9 u0 com.ezterminal.remote/com.ezterminal.remote.MainActivity}',
      applicationName: null,
      dispatchEnabled: true,
      dispatchFrozen: false,
      hasInputChannel: true,
      connectionReady: true,
      paused: false,
    });
    expect(inputOwnerBelongsToReadyApp(owner)).toBe(true);
  });

  it('mirrors API 29 touch-modal and input-channel blocking behavior', () => {
    const legacyWindow = (
      index: number,
      name: string,
      flags: string,
      touchableRegion: string,
      inputFeatures = '0x00000000',
    ): string => `      ${index}: name='${name}', displayId=0, portalToDisplayId=-1, `
      + 'paused=false, hasFocus=false, hasWallpaper=false, visible=true, '
      + `canReceiveKeys=false, flags=${flags}, type=0x00000001, layer=0, `
      + 'frame=[0,0][1080,2280], globalScale=1.000000, '
      + `touchableRegion=${touchableRegion}, inputFeatures=${inputFeatures}, ownerPid=100`;
    const appWindow = legacyWindow(
      2,
      'Window{app u0 com.ezterminal.remote/com.ezterminal.remote.MainActivity}',
      '0x00000020',
      '[0,0][1080,2280]',
    );
    const dump = (firstWindow: string): string => [
      'Input Dispatcher State:',
      '  DispatchEnabled: true',
      '  DispatchFrozen: false',
      '  Display: 0',
      '    Windows:',
      firstWindow,
      appWindow,
      '  Connections:',
      "    1: channelName='app "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + "windowName='app "
        + "com.ezterminal.remote/com.ezterminal.remote.MainActivity (server)', "
        + 'status=NORMAL, monitor=false, inputPublisherBlocked=false',
    ].join('\n');
    const point = { x: 992, y: 1866 };

    expect(parseInputDispatcherTouchOwner(
      dump(legacyWindow(1, 'touch-modal', '0x00000000', '[0,0][10,10]')),
      point,
    )?.name).toBe('touch-modal');
    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump(legacyWindow(1, 'not-touchable', '0x00000010', '[0,0][1080,2280]')),
      point,
    ))).toBe(true);
    expect(inputOwnerBelongsToReadyApp(parseInputDispatcherTouchOwner(
      dump(legacyWindow(1, 'not-touchable', '0x00000010', '[0,0][1080,2280]'))
        .replace('inputPublisherBlocked=false', 'inputPublisherBlocked=true'),
      point,
    ))).toBe(false);

    const noChannelOwner = parseInputDispatcherTouchOwner(
      dump(legacyWindow(1, 'no-input-channel', '0x00000020', '[0,0][1080,2280]', '0x2')),
      point,
    );
    expect(noChannelOwner).toMatchObject({
      name: 'no-input-channel',
      hasInputChannel: false,
    });
    expect(inputOwnerBelongsToReadyApp(noChannelOwner)).toBe(false);

    // API 29 inputFeatures=0x4 is DISABLE_USER_ACTIVITY, not a spy window.
    expect(parseInputDispatcherTouchOwner(
      dump(legacyWindow(1, 'ordinary-legacy-window', '0x00000020', '[0,0][1080,2280]', '0x4')),
      point,
    )?.name).toBe('ordinary-legacy-window');
  });

  it('distinguishes a quiescent IME tracker from a pending native transition', () => {
    expect(parseImeTrackerLiveEntryCount(
      '  mImeTrackerService#History:\n    mLiveEntries: 2 elements',
    )).toBe(2);
    expect(parseImeTrackerLiveEntryCount(
      '  mImeTrackerService#History:\n    mLiveEntries: 0 elements',
    )).toBe(0);
    expect(parseImeTrackerLiveEntryCount('    mLiveEntries: 0 elements')).toBeNull();
    expect(parseImeTrackerLiveEntryCount('  mInputShown=false')).toBeNull();
  });

  it('accumulates API 29 parent offsets even when DecorView has no bounds', () => {
    const output = [
      '    View Hierarchy:',
      '      DecorView@ba864c0[MainActivity]',
      '        android.widget.LinearLayout{one V.E...... 0,0-1080,2148}',
      '          android.widget.FrameLayout{two V.E...... 0,66-1080,2148}',
      '            androidx.appcompat.widget.ContentFrameLayout{three V.E...... 0,0-1080,2082 #1020002 android:id/content}',
      '              androidx.coordinatorlayout.widget.CoordinatorLayout{four V.E...... 0,0-1080,2082}',
      '                com.getcapacitor.CapacitorWebView{five VFEDHVC.. 0,0-1080,2082 #7f0800c4 app:id/webview}',
    ].join('\n');

    expect(parseWebViewDeviceBounds(output, {
      viewportWidth: 393,
      viewportHeight: 758,
      devicePixelRatio: 2.75,
    })).toEqual([0, 66, 1080, 2148]);
  });

  it('parses the API 35 hierarchy including compact braces and aid fields', () => {
    const output = [
      '    View Hierarchy:',
      '      com.android.internal.policy.DecorView{root V.E...... 0,0-1080,2340}[MainActivity]',
      '        android.widget.LinearLayout{one V.E...... 0,0-1080,2274}',
      '          android.widget.FrameLayout{two V.E...... 0,136-1080,2274}',
      '            androidx.appcompat.widget.ContentFrameLayout{three V.E...... 0,0-1080,2138 #1020002 android:id/content}',
      '              com.getcapacitor.CapacitorWebView{four VFEDHVC.. 0,0-1080,2138 #7f0800c4 app:id/webview aid=1073741824}',
    ].join('\n');

    expect(parseWebViewDeviceBounds(output, {
      viewportWidth: 393,
      viewportHeight: 778,
      devicePixelRatio: 2.75,
    })).toEqual([0, 136, 1080, 2274]);
  });

  it.each<{
    name: string;
    dump: string;
    metrics: WebViewViewportMetrics;
    expected: DeviceBounds;
  }>([
    {
      name: 'Fold cover portrait',
      dump: hierarchy([0, 136, 1080, 2457], [1080, 2321], [1080, 2520]),
      metrics: { viewportWidth: 411, viewportHeight: 884, devicePixelRatio: 2.625 },
      expected: [0, 136, 1080, 2457],
    },
    {
      name: 'Fold main portrait',
      dump: hierarchy([0, 114, 2184, 1968], [2184, 1854], [2184, 1968]),
      metrics: { viewportWidth: 939, viewportHeight: 797, devicePixelRatio: 2.325 },
      expected: [0, 114, 2184, 1968],
    },
    {
      name: 'Fold main rotated',
      dump: hierarchy([114, 56, 1968, 2184], [1854, 2128], [1968, 2184]),
      metrics: { viewportWidth: 797, viewportHeight: 915, devicePixelRatio: 2.325 },
      expected: [114, 56, 1968, 2184],
    },
  ])('keeps $name geometry compatible with CDP metrics', ({ dump, metrics, expected }) => {
    expect(parseWebViewDeviceBounds(dump, metrics)).toEqual(expected);
  });

  it('rejects missing, stale, degenerate, and invalid viewport geometry', () => {
    const valid = hierarchy([0, 136, 1080, 2274], [1080, 2138], [1080, 2340]);
    const metrics = { viewportWidth: 393, viewportHeight: 778, devicePixelRatio: 2.75 };

    expect(parseWebViewDeviceBounds('    View Hierarchy:\n      DecorView@none[MainActivity]', metrics)).toBeNull();
    expect(parseWebViewDeviceBounds(valid, { ...metrics, viewportHeight: 400 })).toBeNull();
    expect(parseWebViewDeviceBounds(
      hierarchy([0, 136, 1080, 136], [1080, 0], [1080, 2340]),
      metrics,
    )).toBeNull();
    expect(parseWebViewDeviceBounds(valid, { ...metrics, viewportWidth: 0 })).toBeNull();
  });

  it('maps CSS points into the API-specific physical content frame', () => {
    expect(mapWebViewPointToDevice(
      { x: 393 / 4, y: 758 / 4 },
      [0, 66, 1080, 2148],
      { viewportWidth: 393, viewportHeight: 758 },
    )).toEqual({ x: 270, y: 587 });

    expect(mapWebViewPointToDevice(
      { x: 393 / 4, y: 778 / 4 },
      [0, 136, 1080, 2274],
      { viewportWidth: 393, viewportHeight: 778 },
    )).toEqual({ x: 270, y: 671 });
  });

  it('keeps test-id taps independent from UIAutomator', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../mobile/e2e/lib.ts'),
      'utf8',
    );
    const start = source.indexOf('interface WebViewElementGeometry');
    const end = source.indexOf('export async function waitForTestId(', start);
    const testIdTapSection = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(testIdTapSection).toContain("runAdb(['shell', 'dumpsys', 'activity', APP_ID])");
    expect(testIdTapSection).toContain('forceRefreshDeviceGeometry');
    expect(testIdTapSection).toMatch(
      /forceRefreshDeviceGeometry\s*\|\|\s*!webViewDeviceGeometry/,
    );
    expect(testIdTapSection).not.toContain('tryDumpUi');
    expect(testIdTapSection).not.toContain('uiautomator');
  });

  it('reconnects instead of reusing a timed-out DevTools transport', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../mobile/e2e/lib.ts'),
      'utf8',
    );
    const start = source.indexOf('async function evaluateWebView');
    const end = source.indexOf('export interface WebViewHistorySnapshot', start);
    const evaluationSection = source.slice(start, end);

    expect(evaluationSection).toContain('resetWebViewCdp(timeoutError)');
    expect(evaluationSection).toContain('pending.reject(timeoutError)');
  });
});
