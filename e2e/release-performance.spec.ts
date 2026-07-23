import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const HARNESS_PATH = path.resolve(__dirname, 'release-performance.spec.ts');
const LARGE_OUTPUT_FIXTURE = path.resolve(__dirname, 'fixtures', 'large-plain-output.js');
const RETENTION_PRESSURE_FIXTURE = path.resolve(
  __dirname,
  'fixtures',
  'retention-pressure-output.js',
);
const RELEASE_WARMUP_RUNS = 5;
const RELEASE_MEASUREMENT_RUNS = 25;
const METRIC_ORDER = [
  'cancellationLatencyMs',
  'rows100kCompletionMs',
  'plainOutput1_1MiBCompletionMs',
  'plainOutput12MiBRetentionPressureMs',
] as const;
type MetricName = typeof METRIC_ORDER[number];
interface BenchmarkProtocol {
  readonly evidenceMode: 'release' | 'diagnostic';
  readonly warmupRuns: number;
  readonly measurementRuns: number;
  readonly metricOrder: readonly MetricName[];
}
const NODE_BUILD_ARTIFACTS = [
  'main.js',
  'preload.js',
  'interpreter-process.js',
  'script-host.js',
  'packet-capture-host.js',
] as const;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

interface RuntimeVersions {
  readonly app: string;
  readonly protocol: number;
  readonly buildSha: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
}

interface BenchmarkEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly totalMemoryGiB: number;
  /** Stable comparison token; the underlying Windows MachineGuid is never stored. */
  readonly hostFingerprint: {
    readonly algorithm: 'windows-machine-guid-sha256-v1';
    readonly sha256: string;
  };
  readonly powerPlan: {
    readonly schemeGuid: string;
    /** The currently supplying rail. Unknown is rejected instead of weakening comparisons. */
    readonly powerSource: 'ac' | 'dc';
    /** Windows' documented V1 effective power mode (formerly called an overlay). */
    readonly effectivePowerMode:
      | 'battery-saver'
      | 'better-battery'
      | 'balanced'
      | 'high-performance'
      | 'max-performance';
    /** Hash of the complete base plan settings, including AC/DC values. */
    readonly baseSettingsSha256: string;
    /** Hash of `powercfg /query` so the active overlay is included when present. */
    readonly effectiveSettingsSha256: string;
  };
}

interface WindowsPowerState {
  readonly powerSource: 'ac' | 'dc';
  readonly effectivePowerMode: BenchmarkEnvironment['powerPlan']['effectivePowerMode'];
}

interface WindowsPowerSettings {
  readonly base: Buffer;
  readonly effective: Buffer;
}

interface FileEvidence {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface FixtureEvidence extends FileEvidence {
  readonly id: 'largePlainOutput' | 'retentionPressureOutput';
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly completionMarker: string;
}

interface PerformanceMetric {
  readonly unit: 'ms';
  readonly direction: 'lower';
  readonly warmupRuns: number;
  readonly samples: readonly number[];
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly absoluteBudget?: {
    readonly p95Ms?: number;
    readonly maxMs?: number;
  };
}

function diagnosticCount(
  variable: 'EZTERMINAL_PERFORMANCE_DIAGNOSTIC_WARMUP_RUNS'
  | 'EZTERMINAL_PERFORMANCE_DIAGNOSTIC_MEASUREMENT_RUNS',
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[variable]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${variable} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function benchmarkProtocol(): BenchmarkProtocol {
  if (process.env.EZTERMINAL_RUN_RELEASE_PERFORMANCE === '1') {
    return {
      evidenceMode: 'release',
      warmupRuns: RELEASE_WARMUP_RUNS,
      measurementRuns: RELEASE_MEASUREMENT_RUNS,
      metricOrder: METRIC_ORDER,
    };
  }

  const configuredMetrics = process.env.EZTERMINAL_PERFORMANCE_DIAGNOSTIC_METRICS
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const selectedMetrics = new Set(configuredMetrics?.length ? configuredMetrics : METRIC_ORDER);
  for (const name of selectedMetrics) {
    if (!METRIC_ORDER.includes(name as MetricName)) {
      throw new Error(
        `EZTERMINAL_PERFORMANCE_DIAGNOSTIC_METRICS contains an unknown metric: ${name}`,
      );
    }
  }
  return {
    evidenceMode: 'diagnostic',
    warmupRuns: diagnosticCount(
      'EZTERMINAL_PERFORMANCE_DIAGNOSTIC_WARMUP_RUNS',
      1,
      0,
      RELEASE_WARMUP_RUNS,
    ),
    measurementRuns: diagnosticCount(
      'EZTERMINAL_PERFORMANCE_DIAGNOSTIC_MEASUREMENT_RUNS',
      3,
      1,
      RELEASE_MEASUREMENT_RUNS,
    ),
    metricOrder: METRIC_ORDER.filter((name) => selectedMetrics.has(name)),
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function windowsCommand(file: string, args: readonly string[], maxBuffer = 1024 * 1024): Buffer {
  if (platform() !== 'win32') {
    throw new Error('release performance evidence is supported only on the Windows release host');
  }
  return execFileSync(file, args, {
    encoding: 'buffer',
    maxBuffer,
    windowsHide: true,
  });
}

function windowsPowerState(): WindowsPowerState {
  const script = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class EzTerminalNativePower {
  [StructLayout(LayoutKind.Sequential)]
  public struct SystemPowerStatus {
    public byte ACLineStatus;
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public uint BatteryLifeTime;
    public uint BatteryFullLifeTime;
  }

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  private delegate void EffectivePowerModeCallback(int mode, IntPtr context);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

  [DllImport("powrprof.dll", ExactSpelling = true)]
  private static extern int PowerRegisterForEffectivePowerModeNotifications(
    uint version,
    EffectivePowerModeCallback callback,
    IntPtr context,
    out IntPtr registrationHandle
  );

  [DllImport("powrprof.dll", ExactSpelling = true)]
  private static extern int PowerUnregisterFromEffectivePowerModeNotifications(
    IntPtr registrationHandle
  );

  public static int ReadEffectivePowerMode() {
    int currentMode = -1;
    using (ManualResetEventSlim signal = new ManualResetEventSlim(false)) {
      EffectivePowerModeCallback callback = delegate(int mode, IntPtr context) {
        Interlocked.Exchange(ref currentMode, mode);
        signal.Set();
      };
      IntPtr handle;
      int result = PowerRegisterForEffectivePowerModeNotifications(
        1,
        callback,
        IntPtr.Zero,
        out handle
      );
      if (result != 0) {
        throw new ExternalException(
          "PowerRegisterForEffectivePowerModeNotifications failed",
          result
        );
      }
      try {
        if (!signal.Wait(5000)) {
          throw new TimeoutException("effective power mode callback timed out");
        }
      } finally {
        int unregisterResult =
          PowerUnregisterFromEffectivePowerModeNotifications(handle);
        GC.KeepAlive(callback);
        if (unregisterResult != 0) {
          throw new ExternalException(
            "PowerUnregisterFromEffectivePowerModeNotifications failed",
            unregisterResult
          );
        }
      }
      return Interlocked.CompareExchange(ref currentMode, 0, 0);
    }
  }
}
"@
$status = New-Object EzTerminalNativePower+SystemPowerStatus
if (-not [EzTerminalNativePower]::GetSystemPowerStatus([ref]$status)) {
  throw 'GetSystemPowerStatus failed'
}
$source = switch ($status.ACLineStatus) {
  0 { 'dc' }
  1 { 'ac' }
  255 { throw 'Windows reported an unknown AC line status' }
  default { throw "Unexpected AC line status: $($status.ACLineStatus)" }
}
$mode = [EzTerminalNativePower]::ReadEffectivePowerMode()
[Console]::Out.Write("$source|$mode")
`;
  const output = windowsCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]).toString('utf8').trim();
  const match = output.match(/^(ac|dc)\|([0-4])$/);
  if (!match) {
    throw new Error('could not resolve the Windows power source and effective power mode');
  }
  const effectivePowerModes = [
    'battery-saver',
    'better-battery',
    'balanced',
    'high-performance',
    'max-performance',
  ] as const;
  const effectivePowerMode = effectivePowerModes[Number(match[2])];
  if (!effectivePowerMode) {
    throw new Error('Windows reported an unsupported effective power mode');
  }
  return {
    powerSource: match[1] as 'ac' | 'dc',
    effectivePowerMode,
  };
}

function activeWindowsPowerPlanGuid(): string {
  const output = windowsCommand('powercfg.exe', ['/getactivescheme']);
  const schemeGuid = output.toString('latin1').match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0]?.toLowerCase();
  if (!schemeGuid) {
    throw new Error('could not resolve the active Windows power plan');
  }
  return schemeGuid;
}

function windowsPowerSettings(schemeGuid: string): WindowsPowerSettings {
  return {
    base: windowsCommand(
      'powercfg.exe',
      ['/query', schemeGuid],
      16 * 1024 * 1024,
    ),
    effective: windowsCommand(
      'powercfg.exe',
      ['/query'],
      16 * 1024 * 1024,
    ),
  };
}

function benchmarkEnvironment(): BenchmarkEnvironment {
  const machineGuidOutput = windowsCommand(
    'reg.exe',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
  ).toString('latin1');
  const machineGuid = machineGuidOutput.match(
    /MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i,
  )?.[1]?.toLowerCase();
  if (!machineGuid) {
    throw new Error('could not read the Windows MachineGuid for same-host evidence');
  }

  const schemeGuid = activeWindowsPowerPlanGuid();
  const powerStateBefore = windowsPowerState();
  const powerSettings = windowsPowerSettings(schemeGuid);
  const confirmedPowerSettings = windowsPowerSettings(schemeGuid);
  const powerStateAfter = windowsPowerState();
  const finalSchemeGuid = activeWindowsPowerPlanGuid();
  if (
    schemeGuid !== finalSchemeGuid
    || JSON.stringify(powerStateBefore) !== JSON.stringify(powerStateAfter)
    || !powerSettings.base.equals(confirmedPowerSettings.base)
    || !powerSettings.effective.equals(confirmedPowerSettings.effective)
  ) {
    throw new Error(
      'Windows power plan, source, mode, or settings changed while taking a snapshot',
    );
  }
  const processors = cpus();
  return {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuModel: processors[0]?.model.trim() ?? 'unknown',
    logicalCpuCount: processors.length,
    totalMemoryGiB: Math.round(totalmem() / (1024 ** 3)),
    hostFingerprint: {
      algorithm: 'windows-machine-guid-sha256-v1',
      sha256: sha256(`ezterminal-release-performance-host-v1\0${machineGuid}`),
    },
    powerPlan: {
      schemeGuid,
      powerSource: powerStateBefore.powerSource,
      effectivePowerMode: powerStateBefore.effectivePowerMode,
      baseSettingsSha256: sha256(powerSettings.base),
      effectiveSettingsSha256: sha256(powerSettings.effective),
    },
  };
}

function gitRoot(start: string): string {
  return path.resolve(git(start, 'rev-parse', '--show-toplevel'));
}

function gitSource(root: string): {
  readonly gitHeadSha: string;
  readonly workingTreeDirty: boolean;
} {
  const gitHeadSha = git(root, 'rev-parse', 'HEAD').toLowerCase();
  if (!GIT_SHA_PATTERN.test(gitHeadSha)) {
    throw new Error(`git did not return a full source SHA for ${root}`);
  }
  return {
    gitHeadSha,
    workingTreeDirty: git(root, 'status', '--porcelain=v1', '--untracked-files=all').length > 0,
  };
}

function relativeEvidencePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`performance evidence path is outside its root: ${filePath}`);
  }
  return relative.replaceAll(path.sep, '/');
}

async function fileEvidence(root: string, filePath: string): Promise<FileEvidence> {
  const contents = await readFile(filePath);
  return {
    path: relativeEvidencePath(root, filePath),
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function fixtureOutputEvidence(filePath: string): {
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
} {
  const stdout = execFileSync(process.execPath, [filePath], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    stdoutBytes: stdout.byteLength,
    stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  }));
  return nested.flat();
}

function selectedMainEntry(): string {
  const configured = process.env.EZTERMINAL_PERFORMANCE_MAIN_ENTRY?.trim();
  return path.resolve(configured || DEFAULT_MAIN_ENTRY);
}

async function launchPerformanceApp(mainEntry: string): Promise<ElectronApplication> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ezterm-perf-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.EZTERMINAL_USER_DATA_DIR = userDataDir;
  env.EZTERMINAL_ALLOW_MULTIPLE_INSTANCES = '1';
  return electron.launch({ args: [mainEntry, '--lang=en-US'], env });
}

async function launchArtifactEvidence(
  productRoot: string,
  mainEntry: string,
): Promise<{
  readonly entry: 'build/main.js';
  readonly files: readonly FileEvidence[];
}> {
  const expectedMainEntry = path.join(productRoot, '.vite', 'build', 'main.js');
  if (path.resolve(mainEntry).toLowerCase() !== path.resolve(expectedMainEntry).toLowerCase()) {
    throw new Error(
      'EZTERMINAL_PERFORMANCE_MAIN_ENTRY must select <product-root>/.vite/build/main.js',
    );
  }
  const viteRoot = path.join(productRoot, '.vite');
  const buildRoot = path.join(viteRoot, 'build');
  const rendererRoot = path.join(viteRoot, 'renderer', 'main_window');
  const artifactPaths = [
    ...NODE_BUILD_ARTIFACTS.map((name) => path.join(buildRoot, name)),
    ...(await listFiles(rendererRoot)),
  ];
  const files = await Promise.all(artifactPaths.map((artifact) => fileEvidence(viteRoot, artifact)));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { entry: 'build/main.js', files };
}

async function provenance(
  mainEntry: string,
  runtime: RuntimeVersions,
): Promise<{
  readonly product: {
    readonly name: string;
    readonly version: string;
    readonly protocolVersion: number;
    readonly buildSha: string;
    readonly source: ReturnType<typeof gitSource>;
    readonly lock: FileEvidence;
    readonly runtime: {
      readonly electron: string;
      readonly chrome: string;
      readonly node: string;
    };
    readonly launchArtifacts: Awaited<ReturnType<typeof launchArtifactEvidence>>;
  };
  readonly harness: {
    readonly source: ReturnType<typeof gitSource>;
    readonly lock: FileEvidence;
    readonly runner: {
      readonly node: string;
      readonly playwright: string;
    };
    readonly spec: FileEvidence;
    readonly fixtures: readonly FixtureEvidence[];
  };
}> {
  const productRoot = gitRoot(path.dirname(mainEntry));
  const harnessRoot = gitRoot(ROOT);
  const productPackage = JSON.parse(
    await readFile(path.join(productRoot, 'package.json'), 'utf8'),
  ) as { productName?: unknown; version?: unknown };
  if (
    productPackage.productName !== 'EZTerminal'
    || typeof productPackage.version !== 'string'
    || productPackage.version !== runtime.app
  ) {
    throw new Error('launched artifact runtime identity differs from its product package metadata');
  }
  if (!GIT_SHA_PATTERN.test(runtime.buildSha)) {
    throw new Error(`launched preload did not expose a full build SHA: ${runtime.buildSha}`);
  }

  const require = createRequire(__filename);
  const playwrightPackage = require('@playwright/test/package.json') as { version?: unknown };
  if (typeof playwrightPackage.version !== 'string' || playwrightPackage.version.length === 0) {
    throw new Error('could not resolve the actual Playwright test-runner version');
  }

  const largeFixture = await fileEvidence(harnessRoot, LARGE_OUTPUT_FIXTURE);
  const retentionFixture = await fileEvidence(harnessRoot, RETENTION_PRESSURE_FIXTURE);
  const largeFixtureOutput = fixtureOutputEvidence(LARGE_OUTPUT_FIXTURE);
  const retentionFixtureOutput = fixtureOutputEvidence(RETENTION_PRESSURE_FIXTURE);
  const fixtures: readonly FixtureEvidence[] = [
    {
      id: 'largePlainOutput',
      ...largeFixture,
      ...largeFixtureOutput,
      completionMarker: 'LARGE-OUTPUT-DONE',
    },
    {
      id: 'retentionPressureOutput',
      ...retentionFixture,
      ...retentionFixtureOutput,
      completionMarker: 'RETENTION-PRESSURE-DONE',
    },
  ];

  const productSource = gitSource(productRoot);
  if (productSource.gitHeadSha !== runtime.buildSha.toLowerCase()) {
    throw new Error(
      `launched preload build SHA ${runtime.buildSha} differs from product source ${productSource.gitHeadSha}`,
    );
  }

  return {
    product: {
      name: productPackage.productName,
      version: productPackage.version,
      protocolVersion: runtime.protocol,
      buildSha: runtime.buildSha.toLowerCase(),
      source: productSource,
      lock: await fileEvidence(productRoot, path.join(productRoot, 'pnpm-lock.yaml')),
      runtime: {
        electron: runtime.electron,
        chrome: runtime.chrome,
        node: runtime.node,
      },
      launchArtifacts: await launchArtifactEvidence(productRoot, mainEntry),
    },
    harness: {
      source: gitSource(harnessRoot),
      lock: await fileEvidence(harnessRoot, path.join(harnessRoot, 'pnpm-lock.yaml')),
      runner: {
        node: process.versions.node,
        playwright: playwrightPackage.version,
      },
      spec: await fileEvidence(harnessRoot, HARNESS_PATH),
      fixtures,
    },
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without samples');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function metric(
  samples: readonly number[],
  warmupRuns: number,
  absoluteBudget?: PerformanceMetric['absoluteBudget'],
): PerformanceMetric {
  return {
    unit: 'ms',
    direction: 'lower',
    warmupRuns,
    samples,
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    ...(absoluteBudget ? { absoluteBudget } : {}),
  };
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

async function dismissOnlyBlock(window: Page): Promise<void> {
  await window.getByTestId('block-dismiss').click();
  await expect(window.getByTestId('block')).toHaveCount(0);
}

async function waitForPlainMarker(
  plain: Locator,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  await plain.evaluate((element, options) => new Promise<void>((resolve, reject) => {
    const containsMarker = (node: Node): boolean => node.textContent?.includes(options.marker) ?? false;
    if (containsMarker(element)) {
      resolve();
      return;
    }
    const observer = new MutationObserver((records) => {
      const found = records.some((record) => (
        (record.type === 'characterData' && containsMarker(record.target))
        || [...record.addedNodes].some(containsMarker)
      ));
      if (!found) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      const text = element.textContent ?? '';
      const block = element.closest('[data-testid="block"]');
      const status = block?.querySelector('[data-testid="block-status"]')?.textContent ?? 'missing';
      const output = element.matches('[data-testid="text-output"]')
        ? element
        : element.querySelector('[data-testid="text-output"]');
      reject(new Error(
        `plain-output marker did not render within ${options.timeoutMs}ms; `
        + `status=${status}, textChars=${text.length}, outputChildNodes=${output?.childNodes.length ?? 0}, `
        + `tail=${JSON.stringify(text.slice(-120))}`,
      ));
    }, options.timeoutMs);
  }), { marker, timeoutMs });
}

async function sampleRuns(
  protocol: BenchmarkProtocol,
  metricName: string,
  measure: () => Promise<number>,
): Promise<number[]> {
  const samples: number[] = [];
  const totalRuns = protocol.warmupRuns + protocol.measurementRuns;
  for (let attempt = 0; attempt < totalRuns; attempt += 1) {
    const duration = await measure();
    if (attempt >= protocol.warmupRuns) samples.push(duration);
    if ((attempt + 1) % 5 === 0 || attempt + 1 === totalRuns) {
      console.log(
        `[release-performance] ${metricName} ${attempt + 1}/${totalRuns}`
        + ` latest=${duration.toFixed(2)}ms`,
      );
    }
  }
  return samples;
}

test('performance benchmark records ordered evidence', async ({ browserName }, testInfo) => {
  // The checkpoint baseline itself needs roughly 13 minutes on the validation
  // host. Total-suite scheduling noise must not pre-empt the per-metric p95 and
  // absolute budgets, which are the actual release criteria below.
  test.setTimeout(30 * 60_000);
  void browserName;
  const protocol = benchmarkProtocol();
  const mainEntry = selectedMainEntry();
  const reportEnvironment = benchmarkEnvironment();
  const app = await launchPerformanceApp(mainEntry);
  const window = await app.firstWindow();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  window.on('pageerror', (error) => pageErrors.push(error.message));
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    const runtime = await window.evaluate(() => globalThis.window.ezterminal.versions);
    const reportProvenance = await provenance(mainEntry, runtime);
    const input = window.getByTestId('cmd-input');
    const run = window.getByTestId('btn-run');
    const selectedMetrics = new Set(protocol.metricOrder);
    const metrics: Partial<Record<MetricName, PerformanceMetric>> = {};

    if (selectedMetrics.has('cancellationLatencyMs')) {
      const samples = await sampleRuns(protocol, 'cancellationLatencyMs', async () => {
        await input.fill('gen-rows 100000000');
        await run.click();
        const block = window.getByTestId('block');
        await expect(block.getByTestId('block-status')).toHaveText('running');
        await expect
          .poll(async () => Number((await block.getByTestId('row-count').textContent()) ?? '0'), {
            timeout: 15_000,
          })
          .toBeGreaterThan(0);
        const startedAt = performance.now();
        await block.getByTestId('block-cancel').click();
        await expect(block.getByTestId('block-status')).toHaveText('cancelled', { timeout: 5_000 });
        const duration = elapsedMs(startedAt);
        await dismissOnlyBlock(window);
        return duration;
      });
      metrics.cancellationLatencyMs = metric(
        samples,
        protocol.warmupRuns,
        { p95Ms: 3_000, maxMs: 5_000 },
      );
    }

    if (selectedMetrics.has('rows100kCompletionMs')) {
      const samples = await sampleRuns(protocol, 'rows100kCompletionMs', async () => {
        await input.fill('gen-rows 100000');
        const startedAt = performance.now();
        await run.click();
        const block = window.getByTestId('block');
        await expect(block.getByTestId('row-count')).toHaveText('100000', { timeout: 20_000 });
        await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 20_000 });
        const duration = elapsedMs(startedAt);
        await dismissOnlyBlock(window);
        return duration;
      });
      metrics.rows100kCompletionMs = metric(samples, protocol.warmupRuns);
    }

    if (selectedMetrics.has('plainOutput1_1MiBCompletionMs')) {
      const samples = await sampleRuns(protocol, 'plainOutput1_1MiBCompletionMs', async () => {
        await input.fill(`node ${LARGE_OUTPUT_FIXTURE}`);
        const startedAt = performance.now();
        await run.click();
        const block = window.getByTestId('block');
        const plain = block.getByTestId('pty-plain-block');
        await expect(plain).toBeVisible({ timeout: 15_000 });
        await waitForPlainMarker(plain, 'LARGE-OUTPUT-DONE', 20_000);
        await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 20_000 });
        const duration = elapsedMs(startedAt);
        await dismissOnlyBlock(window);
        return duration;
      });
      metrics.plainOutput1_1MiBCompletionMs = metric(samples, protocol.warmupRuns);
    }

    if (selectedMetrics.has('plainOutput12MiBRetentionPressureMs')) {
      const samples = await sampleRuns(
        protocol,
        'plainOutput12MiBRetentionPressureMs',
        async () => {
          await input.fill(`node ${RETENTION_PRESSURE_FIXTURE}`);
          const startedAt = performance.now();
          await run.click();
          const block = window.getByTestId('block');
          const plain = block.getByTestId('pty-plain-block');
          await expect(plain).toBeVisible({ timeout: 15_000 });
          await waitForPlainMarker(plain, 'RETENTION-PRESSURE-DONE', 45_000);
          await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 45_000 });
          const duration = elapsedMs(startedAt);
          await dismissOnlyBlock(window);
          return duration;
        },
      );
      metrics.plainOutput12MiBRetentionPressureMs = metric(samples, protocol.warmupRuns);
    }

    const finalEnvironment = benchmarkEnvironment();
    if (JSON.stringify(finalEnvironment) !== JSON.stringify(reportEnvironment)) {
      throw new Error(
        'benchmark host, power source, effective power mode, or power-plan settings changed between collection boundaries',
      );
    }
    const report = {
      schemaVersion: 2,
      evidenceMode: protocol.evidenceMode,
      buildSha: reportProvenance.product.buildSha,
      generatedAtUtc: new Date().toISOString(),
      environment: reportEnvironment,
      warmupRuns: protocol.warmupRuns,
      measurementRuns: protocol.measurementRuns,
      metricOrder: protocol.metricOrder,
      provenance: reportProvenance,
      metrics,
    };
    console.log(`[release-performance] ${JSON.stringify(report)}`);
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    await testInfo.attach('release-performance.json', {
      body: Buffer.from(encoded, 'utf8'),
      contentType: 'application/json',
    });
    const reportPath = process.env.EZTERMINAL_PERFORMANCE_REPORT_PATH;
    if (reportPath) {
      await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
      await writeFile(path.resolve(reportPath), encoded, 'utf8');
    }

    if (metrics.cancellationLatencyMs) {
      expect(metrics.cancellationLatencyMs.p95Ms).toBeLessThanOrEqual(3_000);
      expect(metrics.cancellationLatencyMs.maxMs).toBeLessThan(5_000);
    }
    expect(pageErrors, `renderer page errors:\n${pageErrors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `renderer console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
  }
});
