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
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { _electron as electron } from '@playwright/test';

import {
  CHAT_REPLY,
  CODEX_PROJECT_NAME,
  HISTORY_PROJECT_NAME,
  HISTORY_TURNS,
  REPLY_SENTINEL,
  prepareCodexWorkspace,
  seedChatFixture,
} from './profile-chat-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const RENDERER_ROOT = path.join(ROOT, '.vite', 'renderer', 'main_window');
const PROFILE_PREFIX = 'ezterminal-runtime-profile-';
const DEFAULT_OUTPUT = path.join(ROOT, 'test-results', 'runtime-profile.json');
const DEFAULT_INTERACTION_OUTPUT = path.join(ROOT, 'test-results', 'interaction-profile.json');
const DEFAULT_CHAT_OUTPUT = path.join(ROOT, 'test-results', 'chat-profile.json');
const DEFAULT_SAMPLES = 5;
const INTERACTION_SAMPLES_PER_LAUNCH = 30;
const CHAT_FOLLOW_UPS = 5;
const CHAT_SWITCHES = 6;
const CHAT_VIEWPORT = { width: 1440, height: 900 };
const SHELL = '2.0-project-navigation';

/**
 * Workbench destinations measured after boot. In the 2.0 shell Monitor and Remote
 * are items of the Tools menu, so they are opened through it and timed from the
 * menu item's click (`toolsMenuOpenMs` is recorded separately).
 */
export const FEATURES = [
  { name: 'agents', button: 'rail-agents', target: 'agent-hub' },
  { name: 'monitor', menu: 'rail-tools', button: 'btn-toggle-stats', target: 'status-panel' },
  { name: 'remote', menu: 'rail-tools', button: 'rail-remote', target: 'remote-panel' },
  { name: 'settings', button: 'btn-toggle-settings', target: 'settings-panel' },
];

/** Every test id this script depends on; test/profile-runtime.test.ts checks they exist. */
export const TEST_IDS = [
  'pane', 'cmd-input',
  ...new Set(FEATURES.flatMap((feature) => [feature.menu, feature.button, feature.target].filter(Boolean))),
  'agent-new-run', 'conversation-start', 'structured-agent-session', 'structured-agent-composer-input',
  'structured-agent-transcript', 'project-conversation-tree', 'agent-project-history',
];

/**
 * What each number can be compared with. The 1.x shell numbers come from the same
 * script before the 2.0 navigation; "no" means the measured surface changed.
 */
export const COMPARABILITY = {
  interactiveMs: 'same definition (terminal command input visible); the 2.0 workbench does more at boot',
  commandInputFeedbackMs: 'yes: the same terminal command input',
  'featureReadyMs.agents': 'no: in 2.0 this opens the Projects tree, not the agent hub',
  'featureReadyMs.monitor': 'roughly: now timed from the Tools menu item',
  'featureReadyMs.remote': 'roughly: now timed from the Tools menu item',
  'featureReadyMs.settings': 'yes',
  loadedWorkingSetKb: 'no: measured after visiting different panels',
  chat: 'new in 2.0; first chat baseline. switchMs re-shows a conversation that is already an open tab. Working set excludes the fake provider process',
};

export function parseArguments(argv) {
  let samples = DEFAULT_SAMPLES;
  let output = null;
  let interactions = false;
  let chat = false;
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
    } else if (argument === '--chat') {
      chat = true;
    } else if (argument === '--skip-build') {
      skipBuild = true;
    } else {
      throw new Error(`Unknown runtime-profile argument: ${argument}`);
    }
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 30) {
    throw new Error('--samples must be an integer between 1 and 30.');
  }
  // Chat launches put a fake provider on PATH and replace HOME, which would skew boot numbers.
  if (chat && interactions) throw new Error('--chat and --interactions are separate launches; pass one.');
  return {
    chat,
    interactions,
    output: output ?? (chat ? DEFAULT_CHAT_OUTPUT : interactions ? DEFAULT_INTERACTION_OUTPUT : DEFAULT_OUTPUT),
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

export function summarize(values) {
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

async function beginPhase(page, name) {
  return page.evaluate((phaseName) => {
    const profile = window.__ezInteractionProfile;
    profile.phases.push({ name: phaseName, startTime: performance.now(), endTime: null });
    return profile.phases.length - 1;
  }, name);
}

async function endPhase(page, index) {
  await page.evaluate((phaseIndex) => {
    window.__ezInteractionProfile.phases[phaseIndex].endTime = performance.now();
  }, index);
}

/** Input event → next frame, for `count` typed characters into `input` (a locator). */
async function measureInputFeedback(page, input, phaseName, count) {
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
  const phaseIndex = await beginPhase(page, phaseName);
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

async function armClickFeedback(locator) {
  await locator.evaluate((button) => {
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

async function measureFeature(page, feature, interactions) {
  const phaseIndex = interactions ? await beginPhase(page, `feature:${feature.button}`) : null;
  let toolsMenuOpenMs = null;
  if (feature.menu) {
    // The destination exists only while the Tools menu is open.
    const menuStartedAt = performance.now();
    await page.getByTestId(feature.menu).click();
    await page.getByTestId(feature.button).waitFor({ state: 'visible', timeout: 15_000 });
    toolsMenuOpenMs = performance.now() - menuStartedAt;
  }
  const button = page.getByTestId(feature.button);
  if (interactions) await armClickFeedback(button);
  const startedAt = performance.now();
  await button.click();
  await page.getByTestId(feature.target).waitFor({ state: 'visible', timeout: 15_000 });
  const readyMs = performance.now() - startedAt;
  if (!interactions) return { readyMs, feedbackMs: null, toolsMenuOpenMs };
  await page.waitForFunction(() => typeof window.__ezInteractionProfile.feedback === 'number');
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const feedbackMs = await page.evaluate(() => window.__ezInteractionProfile.feedback);
  await endPhase(page, phaseIndex);
  return { readyMs, feedbackMs, toolsMenuOpenMs };
}

function overlapsPhase(entry, phase) {
  const phaseEnd = phase.endTime ?? Number.POSITIVE_INFINITY;
  return entry.startTime < phaseEnd && entry.startTime + entry.duration > phase.startTime;
}

function createProfileDirectory() {
  const profileDirectory = mkdtempSync(path.join(tmpdir(), PROFILE_PREFIX));
  writeFileSync(path.join(profileDirectory, 'settings.json'), JSON.stringify({
    schemaVersion: 1,
    startup: { mode: 'last' },
    bootIntro: false,
    openclawMode: 'off',
    remoteEnabled: false,
    resourceProfile: 'low-resource',
  }), 'utf8');
  return profileDirectory;
}

function launchEnvironment(profileDirectory, extra = {}) {
  const env = { ...process.env };
  env.EZTERMINAL_USER_DATA_DIR = profileDirectory;
  env.EZTERMINAL_ALLOW_MULTIPLE_INSTANCES = '1';
  env.EZTERMINAL_DISABLE_UPDATE_CHECK = '1';
  return { ...env, ...extra };
}

async function readLongTasks(page) {
  const interactionProfile = await page.evaluate(() => ({
    longTasks: window.__ezInteractionProfile.longTasks.slice(),
    phases: window.__ezInteractionProfile.phases.map((phase) => ({ ...phase })),
  }));
  return {
    phaseWindows: interactionProfile.phases,
    longTasks: interactionProfile.longTasks.filter((entry) => (
      interactionProfile.phases.some((phase) => overlapsPhase(entry, phase))
    )),
    observedLongTasks: interactionProfile.longTasks,
  };
}

async function readRendererMetrics(page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const memory = performance.memory;
    return {
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      loadEventMs: navigation?.loadEventEnd ?? null,
      usedJsHeapBytes: memory?.usedJSHeapSize ?? null,
    };
  });
}

async function collectSample(index, interactions) {
  const profileDirectory = createProfileDirectory();
  let application;
  try {
    const startedAt = performance.now();
    application = await electron.launch({ args: [MAIN_ENTRY, '--lang=en-US'], env: launchEnvironment(profileDirectory) });
    const page = await application.firstWindow();
    // The workspace's terminal command input; a resume composer elsewhere shares the test id.
    const commandInput = page.getByTestId('pane').getByTestId('cmd-input').first();
    await commandInput.waitFor({ state: 'visible', timeout: 20_000 });
    const interactiveMs = performance.now() - startedAt;
    const bootProcesses = await readProcessMetrics(application);
    const runtime = await application.evaluate(() => ({ ...process.versions }));

    if (interactions) await installInteractionObserver(page);
    const frameStabilization = interactions ? await waitForResponsiveFrames(page) : null;
    const commandInputFeedback = interactions
      ? await measureInputFeedback(page, commandInput, 'command-input', INTERACTION_SAMPLES_PER_LAUNCH)
      : { events: [], phase: null };

    const featureMeasurements = {};
    for (const feature of FEATURES) {
      // eslint-disable-next-line no-await-in-loop
      featureMeasurements[feature.name] = await measureFeature(page, feature, interactions);
    }
    const featureReadyMs = Object.fromEntries(
      Object.entries(featureMeasurements).map(([name, value]) => [name, value.readyMs]),
    );
    const featureFeedbackMs = Object.fromEntries(
      Object.entries(featureMeasurements).map(([name, value]) => [name, value.feedbackMs]),
    );
    const toolsMenuOpenMs = Object.fromEntries(
      Object.entries(featureMeasurements)
        .filter(([, value]) => value.toolsMenuOpenMs !== null)
        .map(([name, value]) => [name, value.toolsMenuOpenMs]),
    );
    await page.waitForTimeout(500);
    const loadedProcesses = await readProcessMetrics(application);
    const renderer = await readRendererMetrics(page);
    const longTaskData = interactions
      ? await readLongTasks(page)
      : { phaseWindows: [], longTasks: [], observedLongTasks: [] };
    return {
      index,
      runtime,
      interactiveMs,
      frameStabilization,
      featureReadyMs,
      featureFeedbackMs,
      toolsMenuOpenMs,
      commandInputFeedbackMs: commandInputFeedback.events.map((event) => event.duration),
      inputFeedbackEvents: commandInputFeedback.events,
      ...longTaskData,
      bootProcesses,
      loadedProcesses,
      renderer,
    };
  } finally {
    await application?.close().catch(() => undefined);
    safeRemoveProfile(profileDirectory);
  }
}

// ---------------------------------------------------------------- chat mode

/**
 * Sends one message and stamps, on animation frames from the Enter keydown: the
 * person's message painted, the first reply text painted, the reply complete
 * (the fake provider's sentinel), and the conversation back to idle.
 */
async function measureSend(page, composer, text, phaseName) {
  const phaseIndex = await beginPhase(page, phaseName);
  await composer.click();
  await composer.fill(text);
  await composer.evaluate((element) => {
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') window.__ezSendAt = performance.now();
    }, { capture: true, once: true });
  });
  const stamps = page.evaluate(({ marker, sentinel }) => new Promise((resolve, reject) => {
    const stamp = {};
    const deadline = performance.now() + 60_000;
    const tick = () => {
      const now = performance.now();
      const sentAt = window.__ezSendAt;
      if (sentAt !== undefined) {
        const userRow = [...document.querySelectorAll('.chat-row[data-kind="user"]')].find((row) => row.textContent?.includes(marker));
        if (userRow) {
          stamp.userPaintMs ??= now - sentAt;
          const session = userRow.closest('[data-testid="structured-agent-session"]');
          const rows = [...(session?.querySelectorAll('.chat-row') ?? [])];
          const replies = rows.slice(rows.indexOf(userRow) + 1).filter((row) => row.getAttribute('data-kind') === 'assistant');
          if (replies.some((row) => (row.textContent ?? '').trim().length > 0)) stamp.firstAssistantPaintMs ??= now - sentAt;
          if (replies.some((row) => row.textContent?.includes(sentinel))) stamp.assistantCompleteMs ??= now - sentAt;
          if (stamp.assistantCompleteMs !== undefined && session?.getAttribute('data-state') === 'idle') {
            stamp.idleMs = now - sentAt;
            resolve({ ...stamp, sessionId: session.getAttribute('data-session-id') });
            return;
          }
        }
      }
      if (now > deadline) { reject(new Error(`send "${marker}" did not finish: ${JSON.stringify(stamp)}`)); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { marker: text, sentinel: REPLY_SENTINEL });
  await composer.press('Enter');
  const result = await stamps;
  await endPhase(page, phaseIndex);
  await page.evaluate(() => { delete window.__ezSendAt; });
  return result;
}

function sessionLocator(page, sessionId) {
  return page.locator(`[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`);
}

async function openNewConversation(page, workspaceId) {
  if (!await page.getByTestId('agent-hub').isVisible()) await page.getByTestId('rail-agents').click();
  await page.getByTestId('agent-new-run').click();
  const draft = page.getByTestId('conversation-start').last();
  await draft.waitFor({ state: 'visible', timeout: 15_000 });
  await draft.getByRole('combobox', { name: 'Conversation workspace' }).selectOption(workspaceId);
  return draft.getByTestId('structured-agent-composer-input');
}

/** Click a conversation in the project tree until its session shows a reply. */
async function measureSwitch(page, sessionId) {
  if (!await page.getByTestId('agent-hub').isVisible()) await page.getByTestId('rail-agents').click();
  const tree = page.getByTestId('project-conversation-tree');
  const item = tree.locator(`[role="treeitem"][data-session-id="${sessionId}"]`);
  if (!await item.isVisible()) {
    const project = tree.locator('[data-kind="project"]').filter({ hasText: CODEX_PROJECT_NAME }).first();
    if (await project.getAttribute('aria-expanded') === 'false') await project.click();
    await item.waitFor({ state: 'visible', timeout: 15_000 });
  }
  await item.evaluate((element) => {
    element.addEventListener('click', () => { window.__ezClickAt = performance.now(); }, { capture: true, once: true });
  });
  const shown = page.evaluate((id) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 20_000;
    const tick = () => {
      const clickedAt = window.__ezClickAt;
      const session = document.querySelector(`[data-testid="structured-agent-session"][data-session-id="${id}"]`);
      if (clickedAt !== undefined && session && session.getClientRects().length > 0
        && session.checkVisibility?.() !== false && session.querySelector('.chat-row[data-kind="assistant"]')) {
        resolve(performance.now() - clickedAt);
        return;
      }
      if (performance.now() > deadline) { reject(new Error(`switch to ${id} did not show it`)); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), sessionId);
  await item.click();
  const switchMs = await shown;
  await page.evaluate(() => { delete window.__ezClickAt; });
  return switchMs;
}

/** Frame gaps while the transcript scrolls up from the bottom in 60 frames, never near the top loader. */
async function measureScroll(scroll) {
  return scroll.evaluate((element) => new Promise((resolve) => {
    element.scrollTop = element.scrollHeight;
    const bottom = element.scrollTop;
    const stop = Math.min(bottom, 400);
    const step = (bottom - stop) / 60;
    const gaps = [];
    let frame = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (frame > 0) gaps.push(now - last);
      last = now;
      frame += 1;
      if (frame > 60) {
        resolve({ distancePx: bottom - stop, frameGapsMs: gaps, virtual: Boolean(element.querySelector('ol.chat-rows[data-virtual]')) });
        return;
      }
      element.scrollTop = bottom - step * frame;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/** Opens the seeded Claude CLI history and loads every earlier page by scrolling to the top. */
async function measureHistory(page) {
  if (!await page.getByTestId('agent-hub').isVisible()) await page.getByTestId('rail-agents').click();
  await page.getByRole('button', { name: `Manage ${HISTORY_PROJECT_NAME}` }).click();
  await page.getByRole('menuitem', { name: 'CLI history', exact: true }).click();
  await page.getByTestId('agent-project-history').waitFor({ state: 'visible', timeout: 15_000 });
  const row = page.locator('.agent-history-row').first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.evaluate((element) => {
    element.addEventListener('click', () => { window.__ezClickAt = performance.now(); }, { capture: true, once: true });
  });
  const opened = page.evaluate(() => new Promise((resolve, reject) => {
    const deadline = performance.now() + 30_000;
    const tick = () => {
      const panels = document.querySelectorAll('[data-testid="conversation-start"] [data-testid="structured-agent-transcript"]');
      const transcript = panels[panels.length - 1];
      const users = transcript?.querySelectorAll('.chat-row[data-kind="user"]').length ?? 0;
      if (window.__ezClickAt !== undefined && users >= 20) { resolve(performance.now() - window.__ezClickAt); return; }
      if (performance.now() > deadline) { reject(new Error(`history did not open (${users} turns)`)); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  await row.click();
  const openMs = await opened;
  const transcript = page.getByTestId('conversation-start').last().getByTestId('structured-agent-transcript');
  const scroll = transcript.locator('.chat-viewport__scroll');
  const scrollNonVirtual = await measureScroll(scroll);
  const loadEarlierMs = [];
  for (let page_ = 0; page_ < 12; page_ += 1) {
    // eslint-disable-next-line no-await-in-loop
    const loaded = await scroll.evaluate((element) => new Promise((resolve) => {
      const more = [...element.querySelectorAll('button')].some((button) => button.textContent?.includes('Load earlier'));
      if (!more) { resolve(null); return; }
      const height = element.scrollHeight;
      const startedAt = performance.now();
      element.scrollTop = 0;
      const deadline = startedAt + 15_000;
      const tick = () => {
        if (element.scrollHeight > height + 50) { resolve(performance.now() - startedAt); return; }
        if (performance.now() > deadline) { resolve(-1); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    if (loaded === null) break;
    if (loaded < 0) throw new Error('loading earlier history did not grow the transcript within 15 s');
    loadEarlierMs.push(loaded);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(200);
  }
  const scrollAfterLoad = await measureScroll(scroll);
  return { openMs, loadEarlierMs, scrollNonVirtual, scrollAfterLoad };
}

async function collectChatSample(index) {
  const profileDirectory = createProfileDirectory();
  let application;
  try {
    const fixture = seedChatFixture(profileDirectory);
    const startedAt = performance.now();
    application = await electron.launch({ args: [MAIN_ENTRY, '--lang=en-US'], env: launchEnvironment(profileDirectory, fixture.env) });
    const page = await application.firstWindow();
    await page.setViewportSize(CHAT_VIEWPORT);
    await page.getByTestId('rail-agents').waitFor({ state: 'visible', timeout: 20_000 });
    const interactiveMs = performance.now() - startedAt;
    const runtime = await application.evaluate(() => ({ ...process.versions }));
    await installInteractionObserver(page);
    await waitForResponsiveFrames(page);
    const workspaceId = await prepareCodexWorkspace(page, fixture.codexRoot);

    const composerA = await openNewConversation(page, workspaceId);
    const composerInput = await measureInputFeedback(page, composerA, 'composer-input', INTERACTION_SAMPLES_PER_LAUNCH);
    const firstSend = await measureSend(page, composerA, 'Profile message 1', 'first-send');
    const sessionA = firstSend.sessionId;
    const followUpComposer = sessionLocator(page, sessionA).getByTestId('structured-agent-composer-input');
    const followUps = [];
    for (let message = 2; message <= CHAT_FOLLOW_UPS + 1; message += 1) {
      // eslint-disable-next-line no-await-in-loop
      followUps.push(await measureSend(page, followUpComposer, `Profile message ${message}`, 'follow-up-send'));
    }
    const composerB = await openNewConversation(page, workspaceId);
    const sessionB = (await measureSend(page, composerB, 'Profile conversation B', 'setup-send')).sessionId;
    const switchMs = [];
    for (let attempt = 0; attempt < CHAT_SWITCHES; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      switchMs.push(await measureSwitch(page, attempt % 2 === 0 ? sessionA : sessionB));
    }
    const history = await measureHistory(page);
    await page.waitForTimeout(500);
    const loadedProcesses = await readProcessMetrics(application);
    const renderer = await readRendererMetrics(page);
    const longTaskData = await readLongTasks(page);
    const pick = (sends, key) => sends.map((send) => send[key]);
    return {
      index,
      runtime,
      interactiveMs,
      composerInputFeedbackMs: composerInput.events.map((event) => event.duration),
      firstSend,
      followUpSend: {
        userPaintMs: pick(followUps, 'userPaintMs'),
        firstAssistantPaintMs: pick(followUps, 'firstAssistantPaintMs'),
        assistantCompleteMs: pick(followUps, 'assistantCompleteMs'),
        idleMs: pick(followUps, 'idleMs'),
      },
      switchMs,
      history,
      ...longTaskData,
      loadedProcesses,
      renderer,
    };
  } finally {
    await application?.close().catch(() => undefined);
    safeRemoveProfile(profileDirectory);
  }
}

function frameSummary(scrolls) {
  const gaps = scrolls.flatMap((scroll) => scroll.frameGapsMs);
  return { ...summarize(gaps), framesOver33Ms: gaps.filter((gap) => gap > 33.4).length, frames: gaps.length };
}

function summarizeChat(samples) {
  const all = (select) => samples.flatMap(select);
  const longTaskDurations = all((sample) => sample.longTasks.map((entry) => entry.duration));
  return {
    interactiveMs: summarize(samples.map((sample) => sample.interactiveMs)),
    composerInputFeedbackMs: summarize(all((sample) => sample.composerInputFeedbackMs)),
    firstSend: Object.fromEntries(['userPaintMs', 'firstAssistantPaintMs', 'assistantCompleteMs', 'idleMs']
      .map((key) => [key, summarize(samples.map((sample) => sample.firstSend[key]))])),
    followUpSend: Object.fromEntries(['userPaintMs', 'firstAssistantPaintMs', 'assistantCompleteMs', 'idleMs']
      .map((key) => [key, summarize(all((sample) => sample.followUpSend[key]))])),
    // Both conversations are open tabs, so this is re-showing an open conversation from the tree.
    switchMs: summarize(all((sample) => sample.switchMs)),
    history: {
      openMs: summarize(samples.map((sample) => sample.history.openMs)),
      loadEarlierMs: summarize(all((sample) => sample.history.loadEarlierMs)),
      scrollFrameMs: {
        firstPage: frameSummary(samples.map((sample) => sample.history.scrollNonVirtual)),
        afterAllPages: frameSummary(samples.map((sample) => sample.history.scrollAfterLoad)),
        afterAllPagesVirtual: samples.every((sample) => sample.history.scrollAfterLoad.virtual),
      },
    },
    loadedWorkingSetKb: summarize(samples.map((sample) => sample.loadedProcesses.workingSetKb)),
    longTasks: {
      count: longTaskDurations.length,
      over50Ms: longTaskDurations.filter((duration) => duration > 50).length,
      durationMs: longTaskDurations.length ? summarize(longTaskDurations) : null,
    },
  };
}

function summarizeShell(samples, interactions) {
  const featureNames = Object.keys(samples[0].featureReadyMs);
  const summary = {
    interactiveMs: summarize(samples.map((sample) => sample.interactiveMs)),
    featureReadyMs: Object.fromEntries(featureNames.map((name) => [
      name,
      summarize(samples.map((sample) => sample.featureReadyMs[name])),
    ])),
    toolsMenuOpenMs: Object.fromEntries(Object.keys(samples[0].toolsMenuOpenMs).map((name) => [
      name,
      summarize(samples.map((sample) => sample.toolsMenuOpenMs[name])),
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
  return summary;
}

async function main() {
  const {
    chat,
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
    samples.push(chat ? await collectChatSample(index) : await collectSample(index, interactions));
  }

  const summary = chat ? summarizeChat(samples) : summarizeShell(samples, interactions);
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  const report = {
    kind: chat
      ? 'developer-chat-diagnostic'
      : interactions ? 'developer-interaction-diagnostic' : 'developer-runtime-diagnostic',
    releaseEvidence: false,
    generatedAt: new Date().toISOString(),
    gitSha,
    workingTreeDirty: dirty,
    shell: SHELL,
    runtime: samples[0].runtime,
    comparability: COMPARABILITY,
    sampleCount,
    profile: 'low-resource',
    chatFixture: chat ? { reply: CHAT_REPLY, followUps: CHAT_FOLLOW_UPS, switches: CHAT_SWITCHES, historyTurns: HISTORY_TURNS, viewport: CHAT_VIEWPORT } : undefined,
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
