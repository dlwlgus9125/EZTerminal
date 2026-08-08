import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

import { _electron as electron } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const RENDERER_ROOT = path.join(ROOT, '.vite', 'renderer', 'main_window');
const PROFILE_PREFIX = 'ezterminal-runtime-profile-';
const DEFAULT_OUTPUT = path.join(ROOT, 'test-results', 'runtime-profile.json');
const DEFAULT_INTERACTION_OUTPUT = path.join(ROOT, 'test-results', 'interaction-profile.json');
const DEFAULT_SAMPLES = 5;
const INTERACTION_SAMPLES_PER_LAUNCH = 30;

function parseArguments(argv) {
  let samples = DEFAULT_SAMPLES;
  let output = null;
  let interactions = false;
  let skipBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--samples') {
      samples = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
    } else if (argument === '--output') {
      output = path.resolve(ROOT, argv[index + 1] ?? '');
      index += 1;
    } else if (argument === '--interactions') {
      interactions = true;
    } else if (argument === '--skip-build') {
      skipBuild = true;
    } else {
      throw new Error(`Unknown runtime-profile argument: ${argument}`);
    }
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 30) {
    throw new Error('--samples must be an integer between 1 and 30.');
  }
  return {
    interactions,
    output: output ?? (interactions ? DEFAULT_INTERACTION_OUTPUT : DEFAULT_OUTPUT),
    samples,
    skipBuild,
  };
}

function buildApplication() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@electron-forge/cli/package.json');
  const manifest = require('@electron-forge/cli/package.json');
  const binRelative = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin['electron-forge'];
  execFileSync(process.execPath, [path.join(path.dirname(manifestPath), binRelative), 'package'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

function assetRecord(file) {
  const bytes = statSync(file).size;
  return {
    path: path.relative(RENDERER_ROOT, file).replaceAll('\\', '/'),
    bytes,
    gzipBytes: gzipSync(readFileSync(file)).byteLength,
  };
}

function collectBundleMetrics() {
  const html = readFileSync(path.join(RENDERER_ROOT, 'index.html'), 'utf8');
  const initialReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value) => /^(?:\.\/|\/)assets\//u.test(value))
    .map((value) => path.join(RENDERER_ROOT, value.replace(/^\.?\//u, '')));
  const assets = walkFiles(path.join(RENDERER_ROOT, 'assets'))
    .filter((file) => ['.js', '.css'].includes(path.extname(file)))
    .map(assetRecord)
    .sort((left, right) => right.bytes - left.bytes);
  const initialAssets = initialReferences.map(assetRecord);
  return {
    initialAssets,
    initialBytes: initialAssets.reduce((total, asset) => total + asset.bytes, 0),
    initialGzipBytes: initialAssets.reduce((total, asset) => total + asset.gzipBytes, 0),
    javascriptChunkCount: assets.filter((asset) => asset.path.endsWith('.js')).length,
    totalJavaScriptBytes: assets
      .filter((asset) => asset.path.endsWith('.js'))
      .reduce((total, asset) => total + asset.bytes, 0),
    largestAssets: assets.slice(0, 20),
  };
}

function safeRemoveProfile(directory) {
  const resolvedTemp = path.resolve(tmpdir());
  const resolvedDirectory = path.resolve(directory);
  if (
    path.dirname(resolvedDirectory) !== resolvedTemp
    || !path.basename(resolvedDirectory).startsWith(PROFILE_PREFIX)
  ) {
    throw new Error(`Refusing to remove unexpected runtime profile path: ${resolvedDirectory}`);
  }
  rmSync(resolvedDirectory, { force: true, recursive: true });
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  return {
    min: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

async function readProcessMetrics(application) {
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map((entry) => ({
    cpuPercent: entry.cpu.percentCPUUsage,
    privateBytesKb: entry.memory.privateBytes,
    type: entry.type,
    workingSetKb: entry.memory.workingSetSize,
  })));
  return {
    processCount: metrics.length,
    privateBytesKb: metrics.reduce((total, metric) => total + metric.privateBytesKb, 0),
    workingSetKb: metrics.reduce((total, metric) => total + metric.workingSetKb, 0),
    processes: metrics,
  };
}

async function installInteractionObserver(page) {
  await page.evaluate(() => {
    window.__ezInteractionProfile = { longTasks: [], feedback: null, phases: [] };
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__ezInteractionProfile.longTasks.push({
            duration: entry.duration,
            name: entry.name,
            startTime: entry.startTime,
          });
        }
      });
      // Boot work happened before the first actionable control became visible.
      // This diagnostic owns interaction windows only, so do not import the
      // navigation buffer into an input-responsiveness acceptance decision.
      observer.observe({ type: 'longtask' });
      window.__ezInteractionProfile.observer = observer;
    }
  });
}

async function waitForResponsiveFrames(page) {
  return page.evaluate(async () => {
    const startedAt = performance.now();
    const gaps = [];
    let consecutiveResponsiveFrames = 0;
    while (performance.now() - startedAt < 5_000) {
      const frameStartedAt = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const gap = performance.now() - frameStartedAt;
      gaps.push(gap);
      consecutiveResponsiveFrames = gap <= 50 ? consecutiveResponsiveFrames + 1 : 0;
      if (consecutiveResponsiveFrames >= 3) {
        return {
          durationMs: performance.now() - startedAt,
          gapsMs: gaps,
        };
      }
    }
    throw new Error(`renderer frame loop did not stabilize within 5s (${gaps.join(', ')})`);
  });
}

async function measureInputFeedback(page, testId, count) {
  const input = page.getByTestId(testId).last();
  await input.focus();
  await input.fill('');
  await input.evaluate((element, expected) => {
    const profile = window.__ezInteractionProfile;
    profile.inputFeedback = [];
    profile.inputAbort?.abort();
    profile.inputAbort = new AbortController();
    const onInput = () => {
      const startedAt = performance.now();
      requestAnimationFrame(() => {
        const endedAt = performance.now();
        profile.inputFeedback.push({
          duration: endedAt - startedAt,
          endTime: endedAt,
          startTime: startedAt,
        });
      });
    };
    element.addEventListener('input', onInput, { signal: profile.inputAbort.signal });
    profile.expectedInputSamples = expected;
  }, count);
  const phaseIndex = await page.evaluate(() => {
    const profile = window.__ezInteractionProfile;
    profile.phases.push({ name: 'command-input', startTime: performance.now(), endTime: null });
    return profile.phases.length - 1;
  });
  await page.keyboard.type('x'.repeat(count), { delay: 24 });
  await page.waitForFunction(() => (
    window.__ezInteractionProfile.inputFeedback.length
      >= window.__ezInteractionProfile.expectedInputSamples
  ));
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const result = await page.evaluate((index) => {
    const profile = window.__ezInteractionProfile;
    profile.phases[index].endTime = performance.now();
    profile.inputAbort.abort();
    return {
      events: profile.inputFeedback.slice(),
      phase: { ...profile.phases[index] },
    };
  }, phaseIndex);
  await input.fill('');
  return result;
}

async function measureFeature(page, buttonTestId, targetTestId, interactions) {
  const phaseIndex = interactions
    ? await page.evaluate((name) => {
      const profile = window.__ezInteractionProfile;
      profile.phases.push({ name, startTime: performance.now(), endTime: null });
      return profile.phases.length - 1;
    }, `feature:${buttonTestId}`)
    : null;
  if (interactions) {
    await page.getByTestId(buttonTestId).evaluate((button) => {
      button.addEventListener('click', () => {
        const profile = window.__ezInteractionProfile;
        const startedAt = performance.now();
        profile.feedback = null;
        requestAnimationFrame(() => {
          profile.feedback = performance.now() - startedAt;
        });
      }, { capture: true, once: true });
    });
  }
  const startedAt = performance.now();
  await page.getByTestId(buttonTestId).click();
  await page.getByTestId(targetTestId).waitFor({ state: 'visible', timeout: 15_000 });
  const readyMs = performance.now() - startedAt;
  if (!interactions) return { readyMs, feedbackMs: null };
  await page.waitForFunction(() => typeof window.__ezInteractionProfile.feedback === 'number');
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const feedbackMs = await page.evaluate((index) => {
    const profile = window.__ezInteractionProfile;
    profile.phases[index].endTime = performance.now();
    return profile.feedback;
  }, phaseIndex);
  return {
    readyMs,
    feedbackMs,
  };
}

function overlapsPhase(entry, phase) {
  const phaseEnd = phase.endTime ?? Number.POSITIVE_INFINITY;
  return entry.startTime < phaseEnd && entry.startTime + entry.duration > phase.startTime;
}

async function collectSample(index, interactions) {
  const profileDirectory = mkdtempSync(path.join(tmpdir(), PROFILE_PREFIX));
  writeFileSync(path.join(profileDirectory, 'settings.json'), JSON.stringify({
    schemaVersion: 1,
    startup: { mode: 'last' },
    bootIntro: false,
    openclawMode: 'off',
    remoteEnabled: false,
    resourceProfile: 'low-resource',
  }), 'utf8');

  const env = { ...process.env };
  env.EZTERMINAL_USER_DATA_DIR = profileDirectory;
  env.EZTERMINAL_ALLOW_MULTIPLE_INSTANCES = '1';
  env.EZTERMINAL_DISABLE_UPDATE_CHECK = '1';
  let application;
  try {
    const startedAt = performance.now();
    application = await electron.launch({ args: [MAIN_ENTRY, '--lang=en-US'], env });
    const page = await application.firstWindow();
    await page.getByTestId('cmd-input').waitFor({ state: 'visible', timeout: 20_000 });
    const interactiveMs = performance.now() - startedAt;
    const bootProcesses = await readProcessMetrics(application);

    if (interactions) await installInteractionObserver(page);
    const frameStabilization = interactions ? await waitForResponsiveFrames(page) : null;
    const commandInputFeedback = interactions
      ? await measureInputFeedback(page, 'cmd-input', INTERACTION_SAMPLES_PER_LAUNCH)
      : { events: [], phase: null };

    const featureMeasurements = {
      agents: await measureFeature(page, 'rail-agents', 'agent-hub', interactions),
      monitor: await measureFeature(page, 'btn-toggle-stats', 'status-panel', interactions),
      remote: await measureFeature(page, 'rail-remote', 'remote-panel', interactions),
      settings: await measureFeature(page, 'btn-toggle-settings', 'settings-panel', interactions),
    };
    const featureReadyMs = Object.fromEntries(
      Object.entries(featureMeasurements).map(([name, value]) => [name, value.readyMs]),
    );
    const featureFeedbackMs = Object.fromEntries(
      Object.entries(featureMeasurements).map(([name, value]) => [name, value.feedbackMs]),
    );
    await page.waitForTimeout(500);
    const loadedProcesses = await readProcessMetrics(application);
    const renderer = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const memory = performance.memory;
      return {
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
        loadEventMs: navigation?.loadEventEnd ?? null,
        usedJsHeapBytes: memory?.usedJSHeapSize ?? null,
      };
    });
    const interactionProfile = interactions
      ? await page.evaluate(() => ({
        longTasks: window.__ezInteractionProfile.longTasks.slice(),
        phases: window.__ezInteractionProfile.phases.map((phase) => ({ ...phase })),
      }))
      : { longTasks: [], phases: [] };
    const interactionLongTasks = interactionProfile.longTasks.filter((entry) => (
      interactionProfile.phases.some((phase) => overlapsPhase(entry, phase))
    ));
    return {
      index,
      interactiveMs,
      frameStabilization,
      featureReadyMs,
      featureFeedbackMs,
      commandInputFeedbackMs: commandInputFeedback.events.map((event) => event.duration),
      inputFeedbackEvents: commandInputFeedback.events,
      phaseWindows: interactionProfile.phases,
      longTasks: interactionLongTasks,
      observedLongTasks: interactionProfile.longTasks,
      bootProcesses,
      loadedProcesses,
      renderer,
    };
  } finally {
    await application?.close().catch(() => undefined);
    safeRemoveProfile(profileDirectory);
  }
}

async function main() {
  const {
    interactions,
    output,
    samples: sampleCount,
    skipBuild,
  } = parseArguments(process.argv.slice(2));
  if (process.env.EZTERMINAL_RUN_RELEASE_PERFORMANCE === '1') {
    throw new Error('profile:runtime is a developer diagnostic, not a release-performance lane.');
  }
  if (!skipBuild) buildApplication();
  const bundle = collectBundleMetrics();
  const samples = [];
  for (let index = 1; index <= sampleCount; index += 1) {
    console.log(`runtime profile: collecting sample ${index}/${sampleCount}`);
    // Sequential launches prevent one sample from adding CPU/memory pressure to another.
    // eslint-disable-next-line no-await-in-loop
    samples.push(await collectSample(index, interactions));
  }

  const featureNames = Object.keys(samples[0].featureReadyMs);
  const summary = {
    interactiveMs: summarize(samples.map((sample) => sample.interactiveMs)),
    featureReadyMs: Object.fromEntries(featureNames.map((name) => [
      name,
      summarize(samples.map((sample) => sample.featureReadyMs[name])),
    ])),
    bootWorkingSetKb: summarize(samples.map((sample) => sample.bootProcesses.workingSetKb)),
    loadedWorkingSetKb: summarize(samples.map((sample) => sample.loadedProcesses.workingSetKb)),
  };
  if (interactions) {
    const inputValues = samples.flatMap((sample) => sample.commandInputFeedbackMs);
    const longTaskDurations = samples.flatMap((sample) => sample.longTasks.map((entry) => entry.duration));
    summary.commandInputFeedbackMs = summarize(inputValues);
    summary.frameStabilizationMs = summarize(
      samples.map((sample) => sample.frameStabilization.durationMs),
    );
    summary.featureFeedbackMs = Object.fromEntries(featureNames.map((name) => [
      name,
      summarize(samples.map((sample) => sample.featureFeedbackMs[name])),
    ]));
    summary.longTasks = {
      count: longTaskDurations.length,
      over50Ms: longTaskDurations.filter((duration) => duration > 50).length,
      durationMs: longTaskDurations.length ? summarize(longTaskDurations) : null,
    };
  }
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const report = {
    kind: interactions ? 'developer-interaction-diagnostic' : 'developer-runtime-diagnostic',
    releaseEvidence: false,
    generatedAt: new Date().toISOString(),
    gitSha,
    sampleCount,
    profile: 'low-resource',
    interactionBudget: interactions ? {
      feedbackP95Ms: 50,
      maxLongTaskMs: 50,
    } : undefined,
    bundle,
    summary,
    samples,
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`runtime profile written to ${path.relative(ROOT, output)}`);
  console.log(JSON.stringify(summary, null, 2));
  if (interactions) {
    const feedbackSummaries = [
      summary.commandInputFeedbackMs,
      ...Object.values(summary.featureFeedbackMs),
    ];
    const violations = [
      ...feedbackSummaries
        .filter((value) => value.p95 > 50)
        .map((value) => `feedback p95 ${value.p95.toFixed(1)} ms exceeds 50 ms`),
      ...(summary.longTasks.over50Ms > 0
        ? [`${summary.longTasks.over50Ms} long task(s) exceeded 50 ms`]
        : []),
    ];
    report.acceptance = { passed: violations.length === 0, violations };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (violations.length > 0) process.exitCode = 1;
  }
}

await main();
