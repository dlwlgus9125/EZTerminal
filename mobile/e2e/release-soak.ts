/**
 * Android 1.0 release soak gate.
 *
 * Prerequisites (deliberately not provisioned here):
 *  - a booted adb-visible Android emulator/device;
 *  - a current desktop build at `.vite/build/main.js`;
 *  - an E2E-instrumented debug APK at lib.ts's APK_PATH. A normal production
 *    APK is rejected because it cannot provide the compile-time-isolated
 *    reconnect/resume assertions used by this gate.
 *
 * The default run is 30 minutes (`EZTERMINAL_SOAK_DURATION_MS`). It maintains
 * exactly eight sessions, exercises every one with real terminal output,
 * keeps one PTY alive, switches tabs throughout, and performs exactly twenty
 * Android Home/foreground + desktop-bridge outage/recovery cycles. The bridge
 * outage is the deterministic network fault: it closes the real phone socket
 * without mutating emulator-wide networking or affecting unrelated processes.
 *
 * Memory is sampled from both `adb dumpsys meminfo` (app TOTAL PSS) and the
 * Chromium WebView (`performance.memory.usedJSHeapSize`). Baseline and final
 * medians are taken after a configurable quiet period. The cap is 20% growth
 * after subtracting documented measurement noise: 16 MiB PSS and 4 MiB JS
 * heap. In equivalent threshold form: final <= baseline * 1.20 + slack.
 *
 * Run directly with Node's native TypeScript stripping:
 *   node mobile/e2e/release-soak.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  APK_PATH,
  APP_ID,
  MAIN_ENTRY,
  ROOT,
  closeMobileE2eResources,
  closeWebViewDevtools,
  connectAndAuth,
  createTerminalSession,
  getSelectedTestIdIndex,
  getTestIdCount,
  getWebViewMemorySnapshot,
  launchDesktop,
  logcatLines,
  pollLogcat,
  runAdb,
  setTestIdTextValue,
  sleep,
  tapTestId,
  tapTestIdAt,
  waitForTestId,
  waitForTestIdHidden,
  type WebViewMemorySnapshot,
} from './lib.ts';

const SESSION_COUNT = 8;
const RECOVERY_CYCLE_COUNT = 20;
const PERSISTENT_TAB_INDEX = SESSION_COUNT - 1;
const DEFAULT_DURATION_MS = 30 * 60 * 1_000;
const DEFAULT_QUIESCENCE_MS = 15_000;
const TAB_SWITCH_INTERVAL_MS = 10_000;
const OUTPUT_INTERVAL_MS = 60_000;
const NETWORK_DOWN_SETTLE_MS = 1_200;
const RECOVERY_TIMEOUT_MS = 30_000;
const MARKER_SETTLE_MS = 1_500;
const PSS_SLACK_KB = 16 * 1_024;
const RENDERER_HEAP_SLACK_BYTES = 4 * 1_024 * 1_024;

type SamplePhase = 'baseline' | 'soak' | 'final';

interface MemorySample {
  readonly phase: SamplePhase;
  readonly cycle: number | null;
  readonly collectedAt: string;
  readonly elapsedMs: number;
  readonly totalPssKb: number;
  readonly nativeHeapKb: number | null;
  readonly javaHeapKb: number | null;
  readonly renderer: WebViewMemorySnapshot;
}

interface RecoveryCycleReport {
  readonly index: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly reconnectGeneration: number;
  readonly resumedRunId: string;
  readonly reconnectMarkerCount: number;
  readonly resumeMarkerCount: number;
  readonly sessionCount: number;
}

interface GrowthCheck {
  readonly metric: 'totalPssKb' | 'rendererUsedJsHeapBytes';
  readonly baselineMedian: number;
  readonly finalMedian: number;
  readonly rawGrowth: number;
  readonly slack: number;
  readonly growthAfterSlack: number;
  readonly growthAfterSlackPercent: number;
  readonly maxGrowthPercent: 20;
  readonly threshold: number;
  readonly passed: boolean;
}

interface TransportMarker {
  readonly kind: 'connected' | 'reconnect' | 'resume';
  readonly generation: number;
  readonly runId: string | null;
  readonly appVersion: string | null;
  readonly buildSha: string | null;
  readonly line: string;
}

interface SoakReport {
  readonly schemaVersion: 1;
  status: 'running' | 'passed' | 'failed';
  readonly startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  readonly apkPath: string;
  readonly reportPath: string;
  releaseIdentity?: {
    readonly appVersion: string;
    readonly buildSha: string;
  };
  config?: {
    readonly durationMs: number;
    readonly quiescenceMs: number;
    readonly sessionCount: 8;
    readonly recoveryCycles: 20;
    readonly networkFault: 'desktop-bridge-disabled-while-android-backgrounded';
    readonly memoryRule: 'final <= baseline * 1.20 + absolute measurement slack';
    readonly pssSlackKb: number;
    readonly rendererHeapSlackBytes: number;
  };
  e2eApkMarker?: string;
  initialConnectionGeneration?: number;
  readonly cycles: RecoveryCycleReport[];
  readonly memorySamples: MemorySample[];
  growthChecks?: GrowthCheck[];
  markerAudit?: {
    readonly reconnectGenerations: number[];
    readonly resumeKeys: string[];
    readonly resumedRunIds: string[];
    readonly duplicateReconnectGenerations: number[];
    readonly duplicateResumeKeys: string[];
    readonly passed: boolean;
  };
  error?: { readonly message: string; readonly stack?: string };
  readonly cleanupErrors: string[];
}

function resolveReportPath(): string {
  const configured = process.env.EZTERMINAL_SOAK_REPORT_PATH;
  if (!configured) return path.join(ROOT, 'release-assets', 'mobile-soak-report.json');
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
}

function readIntegerEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function parseMetric(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) ? value : null;
}

function parseTransportMarkers(): TransportMarker[] {
  const markers: TransportMarker[] = [];
  for (const line of logcatLines('[ez-e2e] transport:')) {
    const match = line.match(/\[ez-e2e\] transport:(connected|reconnect|resume)\b.*?generation=(\d+)/);
    if (!match) continue;
    markers.push({
      kind: match[1] as TransportMarker['kind'],
      generation: Number(match[2]),
      runId: line.match(/\brunId=([^\s",]+)/)?.[1] ?? null,
      appVersion: line.match(/\bappVersion=([^\s",]+)/)?.[1] ?? null,
      buildSha: line.match(/\bbuildSha=([^\s",]+)/)?.[1] ?? null,
      line,
    });
  }
  return markers;
}

function duplicates<T extends string | number>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const duplicate = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot take a median of zero samples');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function growthCheck(
  metric: GrowthCheck['metric'],
  baselineValues: readonly number[],
  finalValues: readonly number[],
  slack: number,
): GrowthCheck {
  const baselineMedian = median(baselineValues);
  const finalMedian = median(finalValues);
  const rawGrowth = finalMedian - baselineMedian;
  const growthAfterSlack = Math.max(0, rawGrowth - slack);
  const growthAfterSlackPercent = baselineMedian === 0
    ? (growthAfterSlack === 0 ? 0 : Number.POSITIVE_INFINITY)
    : (growthAfterSlack / baselineMedian) * 100;
  const threshold = baselineMedian * 1.2 + slack;
  return {
    metric,
    baselineMedian,
    finalMedian,
    rawGrowth,
    slack,
    growthAfterSlack,
    growthAfterSlackPercent,
    maxGrowthPercent: 20,
    threshold,
    passed: finalMedian <= threshold,
  };
}

async function waitForTabCount(expected: number, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  for (;;) {
    count = await getTestIdCount('tab-pill');
    if (count === expected) return count;
    if (Date.now() > deadline) throw new Error(`Expected ${expected} mounted tabs, found ${count}`);
    await sleep(250);
  }
}

async function activateTab(index: number): Promise<void> {
  await tapTestIdAt('tab-pill-open', index);
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await getSelectedTestIdIndex('tab-pill-open') === index) return;
    if (Date.now() > deadline) throw new Error(`Tab ${index + 1} did not become active`);
    await sleep(200);
  }
}

async function runEcho(tabIndex: number, token: string): Promise<void> {
  await activateTab(tabIndex);
  await setTestIdTextValue('cmd-input', `cmd /c echo ${token}`);
  await tapTestId('btn-run');
  await pollLogcat('[ez-e2e] output:', 20_000, (line) => line.includes(token));
  await waitForTestIdHidden('block-cancel', 20_000);
  await tapTestId('block-dismiss');
  await waitForTestIdHidden('block-dismiss', 10_000);
}

async function startPersistentRun(): Promise<void> {
  await activateTab(PERSISTENT_TAB_INDEX);
  const outputCount = logcatLines('[ez-e2e] output:').length;
  await setTestIdTextValue('cmd-input', 'cmd /c pause');
  await tapTestId('btn-run');
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (logcatLines('[ez-e2e] output:').length > outputCount) break;
    if (Date.now() > deadline) throw new Error('Persistent PTY did not emit initial output');
    await sleep(500);
  }
  await waitForTestId('block-cancel');
}

async function captureMemory(
  report: SoakReport,
  phase: SamplePhase,
  cycle: number | null,
  startedAtMs: number,
): Promise<MemorySample> {
  const meminfo = runAdb(['shell', 'dumpsys', 'meminfo', APP_ID]);
  const totalPssKb = parseMetric(meminfo, /TOTAL PSS:\s*([\d,]+)/i)
    ?? parseMetric(meminfo, /^\s*TOTAL\s+([\d,]+)/m);
  if (totalPssKb === null) throw new Error('adb meminfo did not expose app TOTAL PSS');
  const renderer = await getWebViewMemorySnapshot();
  if (renderer.usedJsHeapBytes === null) {
    throw new Error('E2E WebView does not expose performance.memory.usedJSHeapSize');
  }
  const sample: MemorySample = {
    phase,
    cycle,
    collectedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    totalPssKb,
    nativeHeapKb: parseMetric(meminfo, /Native Heap:\s*([\d,]+)/i),
    javaHeapKb: parseMetric(meminfo, /Java Heap:\s*([\d,]+)/i),
    renderer,
  };
  report.memorySamples.push(sample);
  console.log(
    `[release-soak] memory ${phase}${cycle === null ? '' : ` cycle=${cycle}`}: `
    + `pss=${sample.totalPssKb}KiB renderer=${renderer.usedJsHeapBytes}B dom=${renderer.domNodeCount}`,
  );
  return sample;
}

async function collectMedianWindow(
  report: SoakReport,
  phase: 'baseline' | 'final',
  startedAtMs: number,
): Promise<MemorySample[]> {
  const samples: MemorySample[] = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(await captureMemory(report, phase, null, startedAtMs));
    if (index < 2) await sleep(1_000);
  }
  return samples;
}

async function waitForNewReconnect(knownGenerations: ReadonlySet<number>): Promise<TransportMarker> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  for (;;) {
    const marker = parseTransportMarkers().find(
      (candidate) => candidate.kind === 'reconnect' && !knownGenerations.has(candidate.generation),
    );
    if (marker) return marker;
    if (Date.now() > deadline) throw new Error('No new E2E reconnect marker appeared after network recovery');
    await sleep(500);
  }
}

async function waitForResume(generation: number): Promise<TransportMarker> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  for (;;) {
    const marker = parseTransportMarkers().find(
      (candidate) => candidate.kind === 'resume'
        && candidate.generation === generation
        && candidate.runId !== null,
    );
    if (marker) return marker;
    if (Date.now() > deadline) throw new Error(`No resume marker appeared for reconnect generation ${generation}`);
    await sleep(500);
  }
}

function writeReport(report: SoakReport): void {
  mkdirSync(path.dirname(report.reportPath), { recursive: true });
  writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[release-soak] report: ${report.reportPath}`);
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const reportPath = resolveReportPath();
  const report: SoakReport = {
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date(startedAtMs).toISOString(),
    apkPath: APK_PATH,
    reportPath,
    cycles: [],
    memorySamples: [],
    cleanupErrors: [],
  };
  let app: Awaited<ReturnType<typeof launchDesktop>>['app'] | undefined;

  try {
    const durationMs = readIntegerEnv('EZTERMINAL_SOAK_DURATION_MS', DEFAULT_DURATION_MS);
    const quiescenceMs = readIntegerEnv('EZTERMINAL_SOAK_QUIESCENCE_MS', DEFAULT_QUIESCENCE_MS, true);
    const buildSha = process.env.EZTERMINAL_BUILD_SHA?.trim() ?? '';
    if (!/^[0-9a-f]{40}$/i.test(buildSha)) {
      throw new Error('EZTERMINAL_BUILD_SHA must be the exact 40-hex frozen commit used to build the RC');
    }
    const packageMetadata = JSON.parse(
      readFileSync(path.join(ROOT, 'mobile', 'package.json'), 'utf8'),
    ) as { readonly version?: unknown };
    if (typeof packageMetadata.version !== 'string' || packageMetadata.version.trim() === '') {
      throw new Error('mobile/package.json has no valid app version');
    }
    report.releaseIdentity = {
      appVersion: packageMetadata.version,
      buildSha: buildSha.toLowerCase(),
    };
    report.config = {
      durationMs,
      quiescenceMs,
      sessionCount: SESSION_COUNT,
      recoveryCycles: RECOVERY_CYCLE_COUNT,
      networkFault: 'desktop-bridge-disabled-while-android-backgrounded',
      memoryRule: 'final <= baseline * 1.20 + absolute measurement slack',
      pssSlackKb: PSS_SLACK_KB,
      rendererHeapSlackBytes: RENDERER_HEAP_SLACK_BYTES,
    };

    if (!existsSync(MAIN_ENTRY)) throw new Error(`Desktop build missing: ${MAIN_ENTRY}`);
    if (!existsSync(APK_PATH)) throw new Error(`E2E APK missing: ${APK_PATH}`);

    console.log(`[release-soak] launching ${durationMs}ms soak with ${RECOVERY_CYCLE_COUNT} recovery cycles`);
    const launched = await launchDesktop();
    app = launched.app;
    const desktopWindow = await app.firstWindow();
    await connectAndAuth(launched.token);

    // Compile-time proof, not a filename convention: production APKs contain
    // no `[ez-e2e]` calls and therefore cannot pass this marker assertion.
    report.e2eApkMarker = await pollLogcat('[ez-e2e] theme:', 15_000);
    const initialConnection = await pollLogcat('[ez-e2e] transport:connected', 15_000);
    const parsedInitial = parseTransportMarkers().find((marker) => marker.line === initialConnection)
      ?? parseTransportMarkers().find((marker) => marker.kind === 'connected');
    if (!parsedInitial) throw new Error('E2E APK emitted no parseable initial transport marker');
    if (parsedInitial.appVersion !== report.releaseIdentity.appVersion) {
      throw new Error(
        `Installed E2E APK app version ${JSON.stringify(parsedInitial.appVersion)} does not match `
        + `mobile/package.json ${report.releaseIdentity.appVersion}`,
      );
    }
    if (parsedInitial.buildSha?.toLowerCase() !== report.releaseIdentity.buildSha) {
      throw new Error(
        `Installed E2E APK build SHA ${JSON.stringify(parsedInitial.buildSha)} does not match `
        + `EZTERMINAL_BUILD_SHA ${report.releaseIdentity.buildSha}`,
      );
    }
    report.initialConnectionGeneration = parsedInitial.generation;

    console.log('[release-soak] creating and exercising 8 sessions');
    await createTerminalSession();
    await waitForTabCount(1);
    await runEcho(0, 'soak_seed_1');
    for (let index = 1; index < SESSION_COUNT; index += 1) {
      await tapTestId('tab-add-btn');
      await waitForTabCount(index + 1);
      await runEcho(index, `soak_seed_${index + 1}`);
    }
    await waitForTabCount(SESSION_COUNT);

    console.log(`[release-soak] baseline quiescence ${quiescenceMs}ms`);
    await sleep(quiescenceMs);
    const baselineSamples = await collectMedianWindow(report, 'baseline', startedAtMs);

    await startPersistentRun();
    const soakStartedAtMs = Date.now();
    let nextTabSwitchAt = soakStartedAtMs + TAB_SWITCH_INTERVAL_MS;
    let nextOutputAt = soakStartedAtMs + OUTPUT_INTERVAL_MS;
    let switchIndex = 0;
    let outputSequence = 0;
    const reconnectGenerations = new Set(
      parseTransportMarkers()
        .filter((marker) => marker.kind === 'reconnect')
        .map((marker) => marker.generation),
    );

    const exerciseUntil = async (targetAt: number): Promise<void> => {
      while (Date.now() < targetAt) {
        const now = Date.now();
        if (now >= nextOutputAt) {
          const tabIndex = outputSequence % PERSISTENT_TAB_INDEX;
          outputSequence += 1;
          await runEcho(tabIndex, `soak_live_${outputSequence}`);
          nextOutputAt += OUTPUT_INTERVAL_MS;
          continue;
        }
        if (now >= nextTabSwitchAt) {
          await activateTab(switchIndex % SESSION_COUNT);
          switchIndex += 1;
          nextTabSwitchAt += TAB_SWITCH_INTERVAL_MS;
          continue;
        }
        await sleep(Math.min(1_000, targetAt - now));
      }
    };

    for (let cycleIndex = 1; cycleIndex <= RECOVERY_CYCLE_COUNT; cycleIndex += 1) {
      const targetAt = soakStartedAtMs + Math.floor((durationMs * cycleIndex) / RECOVERY_CYCLE_COUNT);
      await exerciseUntil(targetAt);
      await waitForTabCount(SESSION_COUNT);
      await activateTab(PERSISTENT_TAB_INDEX);

      const unexpectedReconnects = parseTransportMarkers()
        .filter((marker) => marker.kind === 'reconnect' && !reconnectGenerations.has(marker.generation));
      if (unexpectedReconnects.length > 0) {
        throw new Error(`Unexpected reconnect before recovery cycle ${cycleIndex}: generation ${unexpectedReconnects[0].generation}`);
      }

      const cycleStartedAtMs = Date.now();
      console.log(`[release-soak] recovery ${cycleIndex}/${RECOVERY_CYCLE_COUNT}`);
      runAdb(['shell', 'input', 'keyevent', '3']); // Android Home: real background transition
      await desktopWindow.evaluate(() => window.ezterminal.setRemoteEnabled(false));
      await sleep(NETWORK_DOWN_SETTLE_MS);
      closeWebViewDevtools();

      runAdb(['shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`]);
      await waitForTestId('mobile-reconnect-scrim', 15_000);
      await desktopWindow.evaluate(() => window.ezterminal.setRemoteEnabled(true));

      const reconnect = await waitForNewReconnect(reconnectGenerations);
      reconnectGenerations.add(reconnect.generation);
      await waitForTestIdHidden('mobile-reconnect-scrim', RECOVERY_TIMEOUT_MS);
      await waitForTestId('mobile-workspace', RECOVERY_TIMEOUT_MS);
      const resume = await waitForResume(reconnect.generation);
      await sleep(MARKER_SETTLE_MS);

      const generationMarkers = parseTransportMarkers().filter(
        (marker) => marker.generation === reconnect.generation,
      );
      const reconnectMarkerCount = generationMarkers.filter((marker) => marker.kind === 'reconnect').length;
      const resumeMarkerCount = generationMarkers.filter(
        (marker) => marker.kind === 'resume' && marker.runId === resume.runId,
      ).length;
      if (reconnectMarkerCount !== 1 || resumeMarkerCount !== 1) {
        throw new Error(
          `Duplicate/missing transport marker in generation ${reconnect.generation}: `
          + `reconnect=${reconnectMarkerCount}, resume=${resumeMarkerCount}`,
        );
      }

      const sessionCount = await waitForTabCount(SESSION_COUNT);
      report.cycles.push({
        index: cycleIndex,
        startedAt: new Date(cycleStartedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - cycleStartedAtMs,
        reconnectGeneration: reconnect.generation,
        resumedRunId: resume.runId!,
        reconnectMarkerCount,
        resumeMarkerCount,
        sessionCount,
      });

      // Each recovery is followed by a real command round trip on a rotating
      // non-persistent tab, while the long-lived PTY remains mounted elsewhere.
      await runEcho((cycleIndex - 1) % PERSISTENT_TAB_INDEX, `soak_cycle_${cycleIndex}`);
      await captureMemory(report, 'soak', cycleIndex, startedAtMs);
    }

    if (report.cycles.length !== RECOVERY_CYCLE_COUNT) {
      throw new Error(`Expected exactly ${RECOVERY_CYCLE_COUNT} recovery cycles, completed ${report.cycles.length}`);
    }

    await activateTab(PERSISTENT_TAB_INDEX);
    await tapTestId('btn-cancel');
    await waitForTestIdHidden('block-cancel', 20_000);
    await tapTestId('block-dismiss');
    await waitForTestIdHidden('block-dismiss', 10_000);
    await waitForTabCount(SESSION_COUNT);

    console.log(`[release-soak] final quiescence ${quiescenceMs}ms`);
    await sleep(quiescenceMs);
    const finalSamples = await collectMedianWindow(report, 'final', startedAtMs);

    const pssCheck = growthCheck(
      'totalPssKb',
      baselineSamples.map((sample) => sample.totalPssKb),
      finalSamples.map((sample) => sample.totalPssKb),
      PSS_SLACK_KB,
    );
    const rendererCheck = growthCheck(
      'rendererUsedJsHeapBytes',
      baselineSamples.map((sample) => sample.renderer.usedJsHeapBytes!),
      finalSamples.map((sample) => sample.renderer.usedJsHeapBytes!),
      RENDERER_HEAP_SLACK_BYTES,
    );
    report.growthChecks = [pssCheck, rendererCheck];
    const failedGrowth = report.growthChecks.find((check) => !check.passed);
    if (failedGrowth) {
      throw new Error(
        `${failedGrowth.metric} grew beyond 20% + slack: final=${failedGrowth.finalMedian}, `
        + `threshold=${failedGrowth.threshold}`,
      );
    }

    const reconnectGenerationList = report.cycles.map((cycle) => cycle.reconnectGeneration);
    const resumeKeys = report.cycles.map((cycle) => `${cycle.reconnectGeneration}:${cycle.resumedRunId}`);
    const resumedRunIds = [...new Set(report.cycles.map((cycle) => cycle.resumedRunId))];
    const duplicateReconnectGenerations = duplicates(reconnectGenerationList);
    const duplicateResumeKeys = duplicates(resumeKeys);
    const markerAuditPassed = duplicateReconnectGenerations.length === 0
      && duplicateResumeKeys.length === 0
      && reconnectGenerationList.length === RECOVERY_CYCLE_COUNT
      && resumedRunIds.length === 1;
    report.markerAudit = {
      reconnectGenerations: reconnectGenerationList,
      resumeKeys,
      resumedRunIds,
      duplicateReconnectGenerations,
      duplicateResumeKeys,
      passed: markerAuditPassed,
    };
    if (!markerAuditPassed) {
      throw new Error(
        `Transport marker audit failed: reconnect duplicates=${JSON.stringify(duplicateReconnectGenerations)}, `
        + `resume duplicates=${JSON.stringify(duplicateResumeKeys)}, runIds=${JSON.stringify(resumedRunIds)}`,
      );
    }

    report.status = 'passed';
    console.log('[release-soak] PASS: 8 sessions, 20 recoveries, marker uniqueness, and memory bounds');
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
    throw error;
  } finally {
    closeMobileE2eResources();
    try {
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch (error) {
      report.cleanupErrors.push(`Android force-stop: ${String(error)}`);
    }
    if (app) {
      try {
        await app.close();
      } catch (error) {
        report.cleanupErrors.push(`Desktop close: ${String(error)}`);
      }
    }
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAtMs;
    writeReport(report);
  }
}

main().catch((error: unknown) => {
  console.error('[release-soak] ERROR:', error);
  process.exitCode = 1;
});
