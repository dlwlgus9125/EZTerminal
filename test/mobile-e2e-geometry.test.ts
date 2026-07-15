import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  mapWebViewPointToDevice,
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
