import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from './test';
import { launchApp } from './launch-app';
import { readXtermAllBuffer } from './xterm-buffer';
import { RUNTIME_PARKED_SCROLLBACK_LINES } from '../src/shared/runtime-lifecycle';
import { SCROLLBACK_DEFAULT } from '../src/renderer/scrollback';

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FIXTURE = path.resolve(__dirname, 'fixtures', 'lifecycle-soak-output.js');
const SESSION_COUNT = 16;
const POPOUT_COUNT = 8;
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1_000;
const PARK_SETTLE_MS = 32_000;
const STEADY_STATE_PREFILL_LINES = RUNTIME_PARKED_SCROLLBACK_LINES + 100;
const MEMORY_SAMPLE_COUNT = 5;
const MEMORY_SAMPLE_INTERVAL_MS = 1_000;
const PRIVATE_BYTES_SLACK_KB = 64 * 1_024;
const FIRST_PARK_RENDERER_PRIVATE_SLACK_KB = 64 * 1_024;
const RENDERER_HEAP_SLACK_BYTES = 16 * 1_024 * 1_024;
const enabled = process.env.EZTERMINAL_RUN_LIFECYCLE_SOAK === '1';

type SamplePhase = 'baseline' | 'parked' | 'resumed' | 'final';

interface ProcessMetric {
  readonly type: string;
  readonly privateBytesKb: number;
  readonly workingSetKb: number;
}

interface MemorySample {
  readonly phase: SamplePhase;
  readonly cycle: number | null;
  readonly collectedAt: string;
  readonly elapsedMs: number;
  readonly processCount: number;
  readonly privateBytesKb: number;
  readonly workingSetKb: number;
  readonly rendererPrivateBytesKb: number;
  readonly rendererUsedJsHeapBytes: number;
  readonly rendererDomNodes: number;
  readonly rendererWindowCount: number;
  readonly rendererProcessCount: number;
  readonly processes: readonly ProcessMetric[];
}

interface CycleEvidence {
  readonly index: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly target: string;
  readonly token: string;
  readonly parkedWindows: number;
  readonly sessionCount: number;
}

interface GrowthCheck {
  readonly metric: 'privateBytesKb' | 'rendererUsedJsHeapBytes';
  readonly baselineMedian: number;
  readonly finalMedian: number;
  readonly slack: number;
  readonly threshold: number;
  readonly growthAfterSlackPercent: number;
  readonly passed: boolean;
}

interface FirstParkCheck {
  readonly metric: 'rendererPrivateBytesKb';
  readonly baselineMedian: number;
  readonly firstPark: number;
  readonly slack: number;
  readonly threshold: number;
  readonly growthKb: number;
  readonly passed: boolean;
}

interface LifecycleSoakReport {
  readonly schemaVersion: 1;
  status: 'running' | 'passed' | 'failed';
  readonly startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  releaseIdentity?: {
    readonly appVersion: string;
    readonly buildSha: string;
  };
  readonly config: {
    readonly durationMs: number;
    readonly sessionCount: 16;
    readonly mainWindowCount: 1;
    readonly popoutWindowCount: 8;
    readonly baselineWarmupMs: number;
    readonly steadyStatePrefillLines: number;
    readonly parkGraceExerciseMs: number;
    readonly memoryRule: 'final <= baseline * 1.20 + absolute measurement slack';
    readonly memorySampling: 'renderer GC before baseline, first-park, and final samples';
    readonly privateBytesSlackKb: number;
    readonly firstParkRendererPrivateBytesSlackKb: number;
    readonly rendererHeapSlackBytes: number;
  };
  readonly cycles: CycleEvidence[];
  readonly memorySamples: MemorySample[];
  firstParkCheck?: FirstParkCheck;
  growthChecks?: readonly GrowthCheck[];
  error?: { readonly message: string; readonly stack?: string };
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error(`${name} must be an integer from 60000 through 86400000`);
  }
  return value;
}

function reportPath(): string {
  const configured = process.env.EZTERMINAL_LIFECYCLE_SOAK_REPORT_PATH;
  if (!configured) return path.join(ROOT, 'release-assets', 'desktop-lifecycle-soak-report.json');
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot take a median of zero samples');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function growthCheck(
  metric: GrowthCheck['metric'],
  baseline: readonly number[],
  final: readonly number[],
  slack: number,
): GrowthCheck {
  const baselineMedian = median(baseline);
  const finalMedian = median(final);
  const threshold = baselineMedian * 1.2 + slack;
  const growthAfterSlack = Math.max(0, finalMedian - baselineMedian - slack);
  return {
    metric,
    baselineMedian,
    finalMedian,
    slack,
    threshold,
    growthAfterSlackPercent: baselineMedian === 0
      ? (growthAfterSlack === 0 ? 0 : Number.POSITIVE_INFINITY)
      : (growthAfterSlack / baselineMedian) * 100,
    passed: finalMedian <= threshold,
  };
}

function firstParkCheck(
  baseline: readonly number[],
  firstPark: number,
): FirstParkCheck {
  const baselineMedian = median(baseline);
  const threshold = baselineMedian + FIRST_PARK_RENDERER_PRIVATE_SLACK_KB;
  return {
    metric: 'rendererPrivateBytesKb',
    baselineMedian,
    firstPark,
    slack: FIRST_PARK_RENDERER_PRIVATE_SLACK_KB,
    threshold,
    growthKb: firstPark - baselineMedian,
    passed: firstPark <= threshold,
  };
}

async function addTerminalTabs(main: Page): Promise<void> {
  for (let index = 1; index < SESSION_COUNT; index += 1) {
    // Use the real command path so WorkbenchCoordinator owns ids/counters.
    // eslint-disable-next-line no-await-in-loop
    await main.getByTestId('btn-new-tab').click();
  }
  await expect(main.locator('.dv-tab')).toHaveCount(SESSION_COUNT, { timeout: 30_000 });
  await expect(main.getByTestId('pane')).toHaveCount(SESSION_COUNT, { timeout: 30_000 });
}

async function activatePanel(main: Page, panelId: string): Promise<void> {
  await main.evaluate((id) => {
    type DockPanel = { id: string; api: { setActive(): void } };
    const dock = (globalThis as unknown as {
      __ezDock?: { panels: DockPanel[] };
    }).__ezDock;
    const panel = dock?.panels.find((candidate) => candidate.id === id);
    if (!panel) throw new Error(`Missing soak panel ${id}`);
    panel.api.setActive();
  }, panelId);
  await expect(main.locator('[data-testid="pane"]:visible')).toHaveCount(1);
}

async function startWorkloads(main: Page): Promise<void> {
  for (let index = 1; index <= SESSION_COUNT; index += 1) {
    const label = `soak-${index}`;
    // eslint-disable-next-line no-await-in-loop
    await activatePanel(main, `tab-${index}`);
    const pane = main.locator('[data-testid="pane"]:visible');
    // eslint-disable-next-line no-await-in-loop
    await expect(pane).toHaveAttribute('data-session-id', /.+/, { timeout: 15_000 });
    // eslint-disable-next-line no-await-in-loop
    await pane.getByTestId('cmd-input').fill(
      `!node ${OUTPUT_FIXTURE} ${label} ${STEADY_STATE_PREFILL_LINES}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await pane.getByTestId('btn-run').click();
    const pty = pane.getByTestId('pty-block');
    // eslint-disable-next-line no-await-in-loop
    await expect(pty).toHaveAttribute('data-presentation-mode', 'live', { timeout: 15_000 });
    // eslint-disable-next-line no-await-in-loop
    await expect.poll(() => readXtermAllBuffer(pty), { timeout: 20_000 }).toContain(`READY ${label}`);
  }
}

async function addPopout(main: Page, panelId: string, index: number): Promise<void> {
  const opened = await main.evaluate(async ({ id, offset }) => {
    type DockPanel = { id: string };
    type DockApi = {
      panels: DockPanel[];
      addPopoutGroup(
        panel: DockPanel,
        options: { position: { left: number; top: number; width: number; height: number } },
      ): Promise<boolean>;
    };
    const dock = (globalThis as unknown as { __ezDock?: DockApi }).__ezDock;
    const panel = dock?.panels.find((candidate) => candidate.id === id);
    if (!dock || !panel) throw new Error(`Missing popout source ${id}`);
    return dock.addPopoutGroup(panel, {
      position: {
        left: 60 + (offset % 4) * 44,
        top: 50 + Math.floor(offset / 4) * 44,
        width: 720,
        height: 500,
      },
    });
  }, { id: panelId, offset: index });
  expect(opened).toBe(true);
}

function auxiliaryWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes('ez-popout=1'));
}

async function createPopouts(app: ElectronApplication, main: Page): Promise<Map<string, Page>> {
  for (let index = 0; index < POPOUT_COUNT; index += 1) {
    // Move tab-9 through tab-16 into one native window each.
    // eslint-disable-next-line no-await-in-loop
    await addPopout(main, `tab-${SESSION_COUNT - POPOUT_COUNT + index + 1}`, index);
    // eslint-disable-next-line no-await-in-loop
    await expect.poll(() => auxiliaryWindows(app).length, { timeout: 20_000 }).toBe(index + 1);
  }

  const byLabel = new Map<string, Page>();
  for (const candidate of auxiliaryWindows(app)) {
    // eslint-disable-next-line no-await-in-loop
    await candidate.waitForLoadState('domcontentloaded');
    const pty = candidate.getByTestId('pty-block');
    // eslint-disable-next-line no-await-in-loop
    await expect(pty).toHaveCount(1, { timeout: 20_000 });
    // eslint-disable-next-line no-await-in-loop
    await expect.poll(() => readXtermAllBuffer(pty), { timeout: 20_000 }).toMatch(/READY soak-(?:9|1[0-6])/u);
    // Playwright's assertion does not return the polled value, so read once
    // after it has settled.
    // eslint-disable-next-line no-await-in-loop
    const ready = await readXtermAllBuffer(pty);
    const match = ready.match(/READY (soak-(?:9|1[0-6]))/u);
    if (!match) throw new Error('Popout PTY label was not recoverable');
    byLabel.set(match[1]!, candidate);
  }
  expect(byLabel.size).toBe(POPOUT_COUNT);
  return byLabel;
}

async function sessionCount(main: Page): Promise<number> {
  return main.evaluate(async () => {
    const api = (globalThis as unknown as {
      ezterminal: { listSessions(): Promise<readonly unknown[]> };
    }).ezterminal;
    return (await api.listSessions()).length;
  });
}

async function collectMemory(
  app: ElectronApplication,
  phase: SamplePhase,
  cycle: number | null,
  startedAtMs: number,
): Promise<MemorySample> {
  const processes = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(
    (entry) => ({
      type: entry.type,
      privateBytesKb: entry.memory.privateBytes ?? 0,
      workingSetKb: entry.memory.workingSetSize,
    }),
  ));
  const pages = app.windows().filter((page) => !page.isClosed());
  const renderer = await Promise.all(pages.map(async (page) => {
    const nativeWindow = await app.browserWindow(page);
    const [snapshot, processId] = await Promise.all([
      page.evaluate(() => {
        const memory = performance as Performance & {
          memory?: { usedJSHeapSize?: number };
        };
        return {
          usedJsHeapBytes: memory.memory?.usedJSHeapSize ?? 0,
          domNodes: document.getElementsByTagName('*').length,
        };
      }),
      nativeWindow.evaluate((window) => window.webContents.getOSProcessId()),
    ]);
    return { ...snapshot, processId };
  }));
  // Chromium's performance.memory is process-wide. Dockview popout Windows
  // commonly share one renderer process, so count the maximum observation
  // once per OS pid instead of multiplying the same heap by the window count.
  const heapByRendererProcess = new Map<number, number>();
  for (const metric of renderer) {
    heapByRendererProcess.set(
      metric.processId,
      Math.max(heapByRendererProcess.get(metric.processId) ?? 0, metric.usedJsHeapBytes),
    );
  }
  return {
    phase,
    cycle,
    collectedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    processCount: processes.length,
    privateBytesKb: processes.reduce((sum, metric) => sum + metric.privateBytesKb, 0),
    workingSetKb: processes.reduce((sum, metric) => sum + metric.workingSetKb, 0),
    rendererPrivateBytesKb: processes
      .filter((metric) => metric.type === 'Tab')
      .reduce((sum, metric) => sum + metric.privateBytesKb, 0),
    rendererUsedJsHeapBytes: [...heapByRendererProcess.values()]
      .reduce((sum, bytes) => sum + bytes, 0),
    rendererDomNodes: renderer.reduce((sum, metric) => sum + metric.domNodes, 0),
    rendererWindowCount: renderer.length,
    rendererProcessCount: heapByRendererProcess.size,
    processes,
  };
}

async function requestRendererGarbageCollection(app: ElectronApplication): Promise<void> {
  const pages = app.windows().filter((page) => !page.isClosed());
  await Promise.all(pages.map((page) => page.requestGC()));
}

async function collectMedianWindow(
  app: ElectronApplication,
  phase: 'baseline' | 'final',
  startedAtMs: number,
  target: MemorySample[],
): Promise<void> {
  for (let index = 0; index < MEMORY_SAMPLE_COUNT; index += 1) {
    // Measure the retained live set, not an arbitrary point in V8's allocation
    // cycle. Every BrowserWindow can own a distinct isolate even when Chromium
    // places them in one renderer OS process.
    // eslint-disable-next-line no-await-in-loop
    await requestRendererGarbageCollection(app);
    // eslint-disable-next-line no-await-in-loop
    target.push(await collectMemory(app, phase, null, startedAtMs));
    if (index + 1 < MEMORY_SAMPLE_COUNT) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, MEMORY_SAMPLE_INTERVAL_MS));
    }
  }
}

async function minimizePopouts(app: ElectronApplication, pages: readonly Page[]): Promise<void> {
  await Promise.all(pages.map(async (page) => {
    const native = await app.browserWindow(page);
    await native.evaluate((window) => window.minimize());
  }));
}

async function restorePopouts(app: ElectronApplication, pages: readonly Page[]): Promise<void> {
  await Promise.all(pages.map(async (page) => {
    const native = await app.browserWindow(page);
    await native.evaluate((window) => {
      if (window.isMinimized()) window.restore();
      window.showInactive();
    });
  }));
}

async function markPtySurfaceIdentities(pages: readonly Page[]): Promise<ReadonlyMap<Page, string>> {
  const identities = new Map<Page, string>();
  for (const [index, page] of pages.entries()) {
    const token = `surface-${index + 1}-${Date.now().toString(36)}`;
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate((identity) => {
      const host = document.querySelector('[data-testid="pty-block"]') as (
        HTMLDivElement & { __ezTerm?: object }
      ) | null;
      const terminal = host?.__ezTerm as ({ __ezLifecycleParkIdentity?: string } | undefined);
      if (!terminal) throw new Error('live xterm diagnostic seam missing');
      terminal.__ezLifecycleParkIdentity = identity;
    }, token);
    identities.set(page, token);
  }
  return identities;
}

async function expectPtySurfaceState(
  page: Page,
  expectedIdentity: string,
  expectedMode: 'live' | 'parked',
): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector('[data-testid="pty-block"]') as (
      HTMLDivElement & { __ezTerm?: object }
    ) | null;
    const terminal = host?.__ezTerm as ({
      __ezLifecycleParkIdentity?: string;
      options?: { scrollback?: number };
    } | undefined);
    return {
      identity: terminal?.__ezLifecycleParkIdentity ?? null,
      renderer: host?.dataset.xtermRenderer ?? null,
      scrollback: terminal?.options?.scrollback ?? null,
    };
  })).toEqual({
    identity: expectedIdentity,
    renderer: expectedMode === 'parked' ? 'dom' : expect.stringMatching(/^(?:dom|webgl)$/u),
    scrollback: expectedMode === 'parked'
      ? RUNTIME_PARKED_SCROLLBACK_LINES
      : SCROLLBACK_DEFAULT,
  });
}

async function installWindowStateEvidence(main: Page): Promise<void> {
  await main.evaluate(async () => {
    const desktop = globalThis.window.ezterminalDesktop;
    if (!desktop) throw new Error('desktop preload bridge missing');
    const target = globalThis as typeof globalThis & {
      __ezLifecycleSoakWindowSnapshot?: Awaited<ReturnType<typeof desktop.getWindowStates>>;
    };
    target.__ezLifecycleSoakWindowSnapshot = await desktop.getWindowStates();
    desktop.onWindowStatesChanged((snapshot) => {
      target.__ezLifecycleSoakWindowSnapshot = snapshot;
    });
  });
}

async function lifecycleFailureEvidence(
  app: ElectronApplication,
  main: Page,
  page: Page,
): Promise<Record<string, unknown>> {
  const native = await app.browserWindow(page);
  const [nativeState, documentState, cachedSnapshot, directSnapshot] = await Promise.all([
    native.evaluate((window) => ({
      id: window.id,
      focused: window.isFocused(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      destroyed: window.isDestroyed(),
    })),
    page.evaluate(() => ({
      windowName: globalThis.window.name,
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      documentRuntimeWindowName: document.documentElement.dataset.runtimeWindowName ?? null,
      documentRuntimeTier: document.documentElement.dataset.runtimeTier ?? null,
      paneTier: document.querySelector('[data-testid="pane"]')?.getAttribute('data-runtime-tier') ?? null,
      presentationMode: document.querySelector('[data-testid="pty-block"]')
        ?.getAttribute('data-presentation-mode') ?? null,
      sessionId: document.querySelector('[data-testid="pane"]')?.getAttribute('data-session-id') ?? null,
    })),
    main.evaluate(() => (
      (globalThis as typeof globalThis & {
        __ezLifecycleSoakWindowSnapshot?: unknown;
      }).__ezLifecycleSoakWindowSnapshot ?? null
    )),
    main.evaluate(() => globalThis.window.ezterminalDesktop?.getWindowStates() ?? null),
  ]);
  return { nativeState, documentState, cachedSnapshot, directSnapshot };
}

async function sendContinuityToken(
  app: ElectronApplication,
  main: Page,
  popouts: ReadonlyMap<string, Page>,
  targetIndex: number,
  token: string,
): Promise<string> {
  const label = `soak-${targetIndex}`;
  let page = main;
  if (targetIndex <= SESSION_COUNT - POPOUT_COUNT) {
    await activatePanel(main, `tab-${targetIndex}`);
  } else {
    page = popouts.get(label) ?? main;
    if (page === main) throw new Error(`Missing popout for ${label}`);
    const native = await app.browserWindow(page);
    await native.evaluate((window) => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
  }

  const pty = page.locator('[data-testid="pty-block"]:visible');
  await expect(pty).toHaveAttribute('data-presentation-mode', 'live', { timeout: 15_000 });
  await pty.click();
  await page.keyboard.type(token);
  await page.keyboard.press('Enter');
  await expect.poll(() => readXtermAllBuffer(pty), { timeout: 20_000 }).toContain(
    `INPUT ${label} ${token}`,
  );
  return label;
}

const durationMs = integerEnvironment('EZTERMINAL_LIFECYCLE_SOAK_DURATION_MS', DEFAULT_DURATION_MS);

test.skip(!enabled, 'desktop lifecycle soak is release evidence and must be explicitly enabled');
test.setTimeout(durationMs + 15 * 60 * 1_000);

test('main + 8 popouts keep 16 live sessions bounded through repeated park/resume', async () => {
  const startedAtMs = Date.now();
  const report: LifecycleSoakReport = {
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date(startedAtMs).toISOString(),
    config: {
      durationMs,
      sessionCount: SESSION_COUNT,
      mainWindowCount: 1,
      popoutWindowCount: POPOUT_COUNT,
      baselineWarmupMs: PARK_SETTLE_MS,
      steadyStatePrefillLines: STEADY_STATE_PREFILL_LINES,
      parkGraceExerciseMs: PARK_SETTLE_MS,
      memoryRule: 'final <= baseline * 1.20 + absolute measurement slack',
      memorySampling: 'renderer GC before baseline, first-park, and final samples',
      privateBytesSlackKb: PRIVATE_BYTES_SLACK_KB,
      firstParkRendererPrivateBytesSlackKb: FIRST_PARK_RENDERER_PRIVATE_SLACK_KB,
      rendererHeapSlackBytes: RENDERER_HEAP_SLACK_BYTES,
    },
    cycles: [],
    memorySamples: [],
  };
  const output = reportPath();
  let app: ElectronApplication | undefined;

  try {
    app = await launchApp();
    const main = await app.firstWindow();
    await expect(main.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    report.releaseIdentity = await main.evaluate(() => ({
      appVersion: globalThis.window.ezterminal.versions.app,
      buildSha: globalThis.window.ezterminal.versions.buildSha,
    }));
    const expectedBuildSha = process.env.EZTERMINAL_BUILD_SHA?.trim().toLowerCase();
    if (expectedBuildSha && report.releaseIdentity.buildSha.toLowerCase() !== expectedBuildSha) {
      throw new Error(
        `launched preload build SHA ${report.releaseIdentity.buildSha} differs from expected ${expectedBuildSha}`,
      );
    }

    await addTerminalTabs(main);
    await startWorkloads(main);
    const popouts = await createPopouts(app, main);
    await expect.poll(() => app?.windows().length ?? 0, { timeout: 30_000 }).toBe(1 + POPOUT_COUNT);
    await expect.poll(() => sessionCount(main), { timeout: 30_000 }).toBe(SESSION_COUNT);
    await installWindowStateEvidence(main);

    const popoutPages = [...popouts.values()];
    // Native-window creation and the already-hidden main tabs cross the same
    // production grace once before the baseline. This prevents cold Chromium
    // allocator warmup from being misclassified as park growth while keeping
    // the measured popout transition fully load-bearing.
    await new Promise((resolve) => setTimeout(resolve, PARK_SETTLE_MS));
    await collectMedianWindow(app, 'baseline', startedAtMs, report.memorySamples);
    const ptySurfaceIdentities = await markPtySurfaceIdentities(popoutPages);
    const soakStartedAt = Date.now();
    let cycle = 0;
    while (Date.now() - soakStartedAt < durationMs) {
      cycle += 1;
      const cycleStartedAt = new Date().toISOString();
      // eslint-disable-next-line no-await-in-loop
      await minimizePopouts(app, popoutPages);
      // This deliberately crosses the production 30-second grace boundary.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, PARK_SETTLE_MS));
      for (const page of popoutPages) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await expect(page.getByTestId('pane')).toHaveAttribute('data-runtime-tier', 'parked');
        } catch (error) {
          // Preserve the first divergence before waiting to distinguish a
          // delayed timer from an indefinitely cancelled lifecycle deadline.
          // eslint-disable-next-line no-await-in-loop
          const first = await lifecycleFailureEvidence(app, main, page);
          let eventuallyParked = false;
          try {
            // eslint-disable-next-line no-await-in-loop
            await expect(page.getByTestId('pane')).toHaveAttribute('data-runtime-tier', 'parked', {
              timeout: 65_000,
            });
            eventuallyParked = true;
          } catch {
            // The evidence below records the stable non-parked state.
          }
          // eslint-disable-next-line no-await-in-loop
          const after = await lifecycleFailureEvidence(app, main, page);
          throw new Error(
            `pane failed to park in cycle ${cycle}; eventuallyParked=${eventuallyParked}; `
            + `first=${JSON.stringify(first)}; after=${JSON.stringify(after)}`,
            { cause: error },
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await expect(page.getByTestId('pty-block')).toHaveAttribute('data-presentation-mode', 'parked');
        // eslint-disable-next-line no-await-in-loop
        await expectPtySurfaceState(page, ptySurfaceIdentities.get(page)!, 'parked');
      }
      // eslint-disable-next-line no-await-in-loop
      if (cycle === 1) await requestRendererGarbageCollection(app);
      const parkedSample = await collectMemory(app, 'parked', cycle, startedAtMs);
      report.memorySamples.push(parkedSample);
      if (cycle === 1) {
        const baseline = report.memorySamples.filter((sample) => sample.phase === 'baseline');
        report.firstParkCheck = firstParkCheck(
          baseline.map((sample) => sample.rendererPrivateBytesKb),
          parkedSample.rendererPrivateBytesKb,
        );
        if (!report.firstParkCheck.passed) {
          throw new Error(
            `first park added ${report.firstParkCheck.growthKb} KiB renderer private bytes; `
            + `limit=${report.firstParkCheck.slack} KiB`,
          );
        }
      }

      // eslint-disable-next-line no-await-in-loop
      await restorePopouts(app, popoutPages);
      for (const page of popoutPages) {
        // eslint-disable-next-line no-await-in-loop
        await expect(page.getByTestId('pty-block')).toHaveAttribute('data-presentation-mode', 'live', {
          timeout: 20_000,
        });
        // eslint-disable-next-line no-await-in-loop
        await expect(page.getByTestId('pane')).toHaveAttribute('data-runtime-tier', /^(?:active|passive)$/u);
        // eslint-disable-next-line no-await-in-loop
        await expectPtySurfaceState(page, ptySurfaceIdentities.get(page)!, 'live');
      }

      const targetIndex = ((cycle - 1) % SESSION_COUNT) + 1;
      const token = `cycle-${cycle}-${Date.now().toString(36)}`;
      // eslint-disable-next-line no-await-in-loop
      const target = await sendContinuityToken(app, main, popouts, targetIndex, token);
      // eslint-disable-next-line no-await-in-loop
      const count = await sessionCount(main);
      expect(count).toBe(SESSION_COUNT);
      report.cycles.push({
        index: cycle,
        startedAt: cycleStartedAt,
        finishedAt: new Date().toISOString(),
        target,
        token,
        parkedWindows: POPOUT_COUNT,
        sessionCount: count,
      });
      // eslint-disable-next-line no-await-in-loop
      report.memorySamples.push(await collectMemory(app, 'resumed', cycle, startedAtMs));
    }

    await collectMedianWindow(app, 'final', startedAtMs, report.memorySamples);
    const baseline = report.memorySamples.filter((sample) => sample.phase === 'baseline');
    const final = report.memorySamples.filter((sample) => sample.phase === 'final');
    report.growthChecks = [
      growthCheck(
        'privateBytesKb',
        baseline.map((sample) => sample.privateBytesKb),
        final.map((sample) => sample.privateBytesKb),
        PRIVATE_BYTES_SLACK_KB,
      ),
      growthCheck(
        'rendererUsedJsHeapBytes',
        baseline.map((sample) => sample.rendererUsedJsHeapBytes),
        final.map((sample) => sample.rendererUsedJsHeapBytes),
        RENDERER_HEAP_SLACK_BYTES,
      ),
    ];
    const failed = report.growthChecks.find((check) => !check.passed);
    if (failed) {
      throw new Error(
        `${failed.metric} exceeded 20% + slack: final=${failed.finalMedian}, threshold=${failed.threshold}`,
      );
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAtMs;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await app?.close().catch(() => undefined);
  }
});
