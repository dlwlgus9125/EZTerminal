/**
 * QR scanner camera-preview regression.
 *
 * Drives the real Android WebView through a native tap, then samples the
 * playing camera frame. A granted camera that produces only black pixels is
 * the user-visible failure this test guards.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAppCameraClientActive } from './camera-state.ts';
import {
  APK_PATH,
  APP_ID,
  assertNoWebViewJavaScriptRuntimeErrors,
  clearAppDataAndWaitForQuiescence,
  clearLogcat,
  closeMobileE2eResources,
  evaluateWebView,
  runAdb,
  runAdbBinary,
  sleep,
  tapTestId,
  waitForResumedActivity,
  waitForTestId,
  waitForTestIdHidden,
} from './lib.ts';

interface PreviewSample {
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly currentTime: number;
  readonly errorText: string | null;
  readonly nonBlackPixelRatio: number | null;
  readonly averageLuma: number | null;
  readonly presentation: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
    readonly display: string;
    readonly visibility: string;
    readonly opacity: number;
    readonly intersectsViewport: boolean;
    readonly topmostAtCenter: boolean;
  } | null;
}

interface PageState {
  readonly rootChildCount: number;
  readonly visibleText: string;
  readonly bodyBackground: string;
  readonly scannerPresent: boolean;
  readonly viewport: { readonly width: number; readonly height: number; readonly scrollY: number };
  readonly backdrop: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
    readonly position: string;
  } | null;
  readonly sheet: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
    readonly position: string;
  } | null;
  readonly containingBlocks: readonly string[];
}

const SAMPLE_EDGE_PX = 96;
const PREVIEW_TIMEOUT_MS = 20_000;
const MIN_NON_BLACK_PIXEL_RATIO = 0.05;
const SCREENSHOT_PATH = path.join(tmpdir(), 'ezterminal-qr-scanner.png');
const MINIMAL_REPRODUCTION = process.argv.includes('--minimal');

function readPreviewSample(): Promise<PreviewSample> {
  return evaluateWebView<PreviewSample>(`(() => {
    const video = document.querySelector('[data-testid="pairing-scan-video"]');
    const error = document.querySelector('[data-testid="pairing-scan-error"]');
    const isVideo = video instanceof HTMLVideoElement;
    const rect = isVideo ? video.getBoundingClientRect() : null;
    const style = isVideo ? getComputedStyle(video) : null;
    const centerX = rect ? Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)) : 0;
    const centerY = rect ? Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)) : 0;
    const base = {
      readyState: isVideo ? video.readyState : -1,
      videoWidth: isVideo ? video.videoWidth : 0,
      videoHeight: isVideo ? video.videoHeight : 0,
      currentTime: isVideo ? video.currentTime : -1,
      errorText: error ? error.textContent : null,
      nonBlackPixelRatio: null,
      averageLuma: null,
      presentation: rect && style ? {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        display: style.display,
        visibility: style.visibility,
        opacity: Number.parseFloat(style.opacity),
        intersectsViewport: (
          rect.right > 0
          && rect.bottom > 0
          && rect.left < innerWidth
          && rect.top < innerHeight
        ),
        topmostAtCenter: document.elementFromPoint(centerX, centerY) === video,
      } : null,
    };
    if (
      !(video instanceof HTMLVideoElement)
      || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      || video.videoWidth <= 0
      || video.videoHeight <= 0
    ) return base;

    const canvas = document.createElement('canvas');
    const scale = Math.min(
      1,
      ${SAMPLE_EDGE_PX} / Math.max(video.videoWidth, video.videoHeight),
    );
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return base;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    let luma = 0;
    const count = pixels.length / 4;
    for (let index = 0; index < pixels.length; index += 4) {
      const sampleLuma = (
        0.2126 * pixels[index]
        + 0.7152 * pixels[index + 1]
        + 0.0722 * pixels[index + 2]
      );
      luma += sampleLuma;
      if (sampleLuma >= 8) nonBlack += 1;
    }
    return {
      ...base,
      nonBlackPixelRatio: nonBlack / count,
      averageLuma: luma / count,
    };
  })()`);
}

function hasActiveCameraClient(timeoutMs = 4_000): boolean {
  const dump = runAdb(['shell', 'dumpsys', 'media.camera'], timeoutMs);
  return parseAppCameraClientActive(dump, APP_ID);
}

async function waitForCameraClientState(
  expectedActive: boolean,
  timeoutMs: number,
  failureMessage: string,
): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError: unknown;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const detail = lastError ? ` (${String(lastError)})` : '';
      throw new Error(`${failureMessage}${detail}`);
    }
    try {
      const active = hasActiveCameraClient(Math.min(4_000, remainingMs));
      lastError = undefined;
      if (Date.now() <= deadline && active === expectedActive) {
        return Date.now() - startedAt;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
}

async function waitForNonBlackPreview(label: string): Promise<PreviewSample> {
  const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
  let sample = await readPreviewSample();
  while (
    sample.errorText === null
    && (sample.nonBlackPixelRatio ?? 0) < MIN_NON_BLACK_PIXEL_RATIO
    && Date.now() < deadline
  ) {
    await sleep(250);
    sample = await readPreviewSample();
  }

  console.log(`[qr-scanner] ${label}: ${JSON.stringify(sample)}`);
  const assertVisibleSample = (candidate: PreviewSample): void => {
    const presentation = candidate.presentation;
    if (
      presentation === null
      || presentation.display === 'none'
      || presentation.visibility !== 'visible'
      || !Number.isFinite(presentation.opacity)
      || presentation.opacity < 0.95
      || !presentation.intersectsViewport
      || !presentation.topmostAtCenter
      || presentation.width < 100
      || presentation.height < 100
    ) {
      throw new Error(
        'QR SCANNER PREVIEW NOT VISIBLE: the sampled camera frame is not a '
        + `large, opaque, topmost viewport surface (${JSON.stringify(candidate)})`,
      );
    }
    if (candidate.errorText !== null) {
      throw new Error(`QR scanner reported a camera error instead of a preview: ${candidate.errorText}`);
    }
    if ((candidate.nonBlackPixelRatio ?? 0) < MIN_NON_BLACK_PIXEL_RATIO) {
      throw new Error(
        'QR SCANNER BLACK SCREEN: camera permission is granted but the live '
        + `preview remained black (${JSON.stringify(candidate)})`,
      );
    }
  };

  assertVisibleSample(sample);
  await sleep(750);
  const advancingSample = await readPreviewSample();
  console.log(`[qr-scanner] ${label} advancement: ${JSON.stringify(advancingSample)}`);
  assertVisibleSample(advancingSample);
  if (advancingSample.currentTime < sample.currentTime + 0.1) {
    throw new Error(
      'QR SCANNER FROZEN FRAME: the preview timestamp did not advance '
      + `(${sample.currentTime} -> ${advancingSample.currentTime})`,
    );
  }
  return advancingSample;
}

async function main(): Promise<void> {
  if (!MINIMAL_REPRODUCTION) {
    console.log('[qr-scanner] installing APK with fresh app data...');
    runAdb(['install', '-r', APK_PATH]);
    await clearAppDataAndWaitForQuiescence();
    runAdb(['shell', 'pm', 'grant', APP_ID, 'android.permission.CAMERA']);
  } else {
    console.log('[qr-scanner] minimal reproduction: reusing the installed app and permission state');
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
  }
  clearLogcat();
  runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
  await waitForResumedActivity(`${APP_ID}/.MainActivity`, 45_000);
  await waitForTestId('connect-screen', 45_000);

  console.log('[qr-scanner] opening scanner through a real Android tap...');
  await tapTestId('connect-scan-qr');
  await sleep(1_200);

  writeFileSync(SCREENSHOT_PATH, runAdbBinary(['exec-out', 'screencap', '-p']));
  const pageState = await evaluateWebView<PageState>(`(() => {
    const root = document.getElementById('root');
    const backdrop = document.querySelector('[data-testid="pairing-scanner-backdrop"]');
    const sheet = document.querySelector('[data-testid="pairing-scanner"]');
    const rectOf = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        position: getComputedStyle(node).position,
      };
    };
    const containingBlocks = [];
    for (
      let current = backdrop instanceof HTMLElement ? backdrop.parentElement : null;
      current;
      current = current.parentElement
    ) {
      const style = getComputedStyle(current);
      if (
        style.transform !== 'none'
        || style.filter !== 'none'
        || style.perspective !== 'none'
        || style.contain !== 'none'
        || style.willChange.includes('transform')
      ) {
        containingBlocks.push(
          current.tagName.toLowerCase()
          + (current.id ? '#' + current.id : '')
          + (current.className ? '.' + String(current.className).trim().replace(/ +/g, '.') : '')
          + ':transform=' + style.transform
          + ',filter=' + style.filter
          + ',contain=' + style.contain
          + ',willChange=' + style.willChange
        );
      }
    }
    return {
      rootChildCount: root ? root.childElementCount : -1,
      visibleText: document.body.innerText.trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      scannerPresent: sheet !== null,
      viewport: { width: innerWidth, height: innerHeight, scrollY },
      backdrop: rectOf(backdrop),
      sheet: rectOf(sheet),
      containingBlocks,
    };
  })()`);
  const runtimeErrors = runAdb(['logcat', '-d', '-v', 'brief'])
    .split(/\r?\n/)
    .filter((line) => (
      line.includes('Capacitor/Console')
      && (line.includes('Uncaught Error') || line.includes('Mobile navigation layers require'))
    ));
  console.log(`[qr-scanner] screenshot: ${SCREENSHOT_PATH}`);
  console.log(`[qr-scanner] page: ${JSON.stringify(pageState)}`);
  console.log(`[qr-scanner] runtime-errors: ${JSON.stringify(runtimeErrors)}`);
  if (
    pageState.rootChildCount === 0
    && pageState.visibleText.length === 0
    && runtimeErrors.some((line) => line.includes('Uncaught Error'))
  ) {
    throw new Error(
      'QR SCANNER BLACK SCREEN: tapping Scan QR emptied the WebView root '
      + `against ${pageState.bodyBackground}`,
    );
  }
  if (
    pageState.backdrop === null
    || pageState.backdrop.position !== 'fixed'
    || Math.abs(pageState.backdrop.top) > 1
    || Math.abs(pageState.backdrop.left) > 1
    || Math.abs(pageState.backdrop.width - pageState.viewport.width) > 1
    || Math.abs(pageState.backdrop.height - pageState.viewport.height) > 1
    || pageState.sheet === null
    || Math.abs(pageState.sheet.top) > 1
    || Math.abs(pageState.sheet.left) > 1
    || Math.abs(pageState.sheet.width - pageState.viewport.width) > 1
    || Math.abs(pageState.sheet.height - pageState.viewport.height) > 1
    || pageState.containingBlocks.length > 0
  ) {
    throw new Error(
      'QR SCANNER NOT FULLSCREEN: the live scanner backdrop does not cover '
      + `the WebView viewport (${JSON.stringify(pageState)})`,
    );
  }

  await waitForTestId('pairing-scanner');
  await waitForNonBlackPreview('initial preview');

  const foregroundCameraActive = hasActiveCameraClient();
  console.log(`[qr-scanner] foreground camera active: ${String(foregroundCameraActive)}`);
  if (!foregroundCameraActive) {
    throw new Error('QR scanner rendered a frame without owning an active camera client');
  }

  console.log('[qr-scanner] sending the app to Android Home...');
  runAdb(['shell', 'input', 'keyevent', '3']);
  const backgroundReleaseMs = await waitForCameraClientState(
    false,
    8_000,
    'QR SCANNER CAMERA ACTIVE IN BACKGROUND',
  );
  console.log(`[qr-scanner] background camera released after ${backgroundReleaseMs} ms`);

  console.log('[qr-scanner] returning to the app after background cleanup...');
  runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
  await waitForResumedActivity(`${APP_ID}/.MainActivity`);
  await waitForTestId('connect-screen', 45_000);
  await waitForTestIdHidden('pairing-scanner');
  if (hasActiveCameraClient()) {
    throw new Error('QR SCANNER REOPENED CAMERA WITHOUT AN EXPLICIT USER ACTION');
  }

  console.log('[qr-scanner] reopening the scanner after resume...');
  await tapTestId('connect-scan-qr');
  await waitForTestId('pairing-scanner');
  await waitForNonBlackPreview('reopened preview');
  if (!hasActiveCameraClient()) {
    throw new Error('QR scanner did not reacquire the camera after an explicit reopen');
  }

  console.log('[qr-scanner] closing the scanner through Android Back...');
  runAdb(['shell', 'input', 'keyevent', '4']);
  await waitForTestIdHidden('pairing-scanner');
  const backReleaseMs = await waitForCameraClientState(
    false,
    5_000,
    'QR SCANNER CAMERA ACTIVE AFTER ANDROID BACK',
  );
  console.log(`[qr-scanner] Android Back camera released after ${backReleaseMs} ms`);
  const focusRestored = await evaluateWebView<boolean>(`(() => (
    document.activeElement === document.querySelector('[data-testid="connect-scan-qr"]')
  ))()`);
  console.log(`[qr-scanner] trigger focus restored: ${String(focusRestored)}`);
  if (!focusRestored) {
    throw new Error('QR SCANNER DID NOT RESTORE TRIGGER FOCUS AFTER ANDROID BACK');
  }

  assertNoWebViewJavaScriptRuntimeErrors();
  console.log(
    '[qr-scanner] PASS: fullscreen preview, background release, explicit reacquire, '
    + 'Android Back release, and trigger focus',
  );
}

try {
  await main();
} finally {
  try {
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
  } catch {
    // Best-effort cleanup must not hide the primary assertion.
  }
  closeMobileE2eResources();
}
