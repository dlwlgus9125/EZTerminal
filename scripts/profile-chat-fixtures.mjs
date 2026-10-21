// Fixtures for `profile-runtime.mjs --chat`: a deterministic fake Codex and a long
// Claude CLI history, all inside one temporary profile. Ported from the e2e helpers
// (agent-results.spec.ts, agent-history.spec.ts), which a plain .mjs cannot import.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const FAKE_CODEX_DIR = path.join(ROOT, 'e2e', 'fixtures', 'fake-codex');
export const CLAUDE_SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const HISTORY_PROJECT_NAME = 'Handoff';
export const CODEX_PROJECT_NAME = 'Profile Codex';
/** Streamed by the fake Codex for every turn; ends with the completion sentinel. */
export const CHAT_REPLY = { chars: 1200, chunks: 24, chunkDelayMs: 20, startDelayMs: 50 };
export const REPLY_SENTINEL = '[[end]]';
export const HISTORY_TURNS = 150;
const HISTORY_REPLY = 'A recorded reply long enough to wrap across several lines in the transcript. '.repeat(5).trim();

/** Same lossy encoding Claude Code uses for its project folders (claude-history-adapter.ts). */
export function encodeClaudeProjectDirName(cwd) {
  const replaced = cwd.replace(/[^a-zA-Z0-9]/gu, '-');
  if (replaced.length <= 200) return replaced;
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return `${replaced.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function envelope(cwd, index) {
  return {
    parentUuid: index === 0 ? null : `uuid-${index - 1}`,
    isSidechain: false,
    uuid: `uuid-${index}`,
    timestamp: new Date(Date.UTC(2026, 6, 27, 0, 0, 0) + index * 1000).toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: CLAUDE_SESSION_ID,
    version: '2.1.220',
    gitBranch: 'main',
  };
}

function seedClaudeHistory(home, projectRoot, turns) {
  const directory = path.join(home, '.claude', 'projects', encodeClaudeProjectDirName(projectRoot));
  mkdirSync(directory, { recursive: true });
  const records = [{ type: 'mode', mode: 'normal', sessionId: CLAUDE_SESSION_ID }];
  for (let turn = 1; turn <= turns; turn += 1) {
    records.push(
      { ...envelope(projectRoot, turn * 2), type: 'user', message: { role: 'user', content: `history turn ${turn}` }, origin: { kind: 'human' }, promptSource: 'typed' },
      { ...envelope(projectRoot, turn * 2 + 1), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${HISTORY_REPLY} (${turn})` }], stop_reason: 'end_turn' } },
    );
  }
  writeFileSync(path.join(directory, `${CLAUDE_SESSION_ID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  writeFileSync(path.join(home, '.claude', 'history.jsonl'), `${JSON.stringify({
    display: `history turn ${turns}`, pastedContents: {}, timestamp: 1_785_181_625_234, project: projectRoot, sessionId: CLAUDE_SESSION_ID,
  })}\n`, 'utf8');
}

/** Seeds the profile and returns the environment additions for the launch. */
export function seedChatFixture(profileDirectory) {
  const codexRoot = path.join(profileDirectory, 'codex-project');
  const claudeRoot = path.join(profileDirectory, 'claude-project');
  const home = path.join(profileDirectory, 'home');
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(claudeRoot, { recursive: true });
  seedClaudeHistory(home, claudeRoot, HISTORY_TURNS);
  // A project EZTerminal observed Agent work in, so its CLI history is listed.
  writeFileSync(path.join(profileDirectory, 'agent-projects.json'), JSON.stringify({
    version: 3,
    projects: [{
      projectId: 'profile-history-project', name: HISTORY_PROJECT_NAME, primaryRoot: claudeRoot, additionalRoots: [],
      pinned: true, origin: 'terminal', lastActiveAt: 1_785_181_625_234, createdAt: 1_785_181_600_000, updatedAt: 1_785_181_625_234,
    }],
  }), 'utf8');
  writeFileSync(path.join(profileDirectory, 'ezterminal-e2e-codex-reply.json'), JSON.stringify(CHAT_REPLY), 'utf8');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  return {
    codexRoot,
    claudeRoot,
    env: {
      [pathKey]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[pathKey] ?? ''}`,
      TMPDIR: profileDirectory,
      HOME: home,
      USERPROFILE: home,
      EZTERMINAL_DISABLE_OPENCLAW_SUPERVISOR: '1',
    },
  };
}

async function sendDaemonCommand(page, type, payload, idPrefix) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const receipt = await page.evaluate(async ({ commandType, commandPayload, commandId }) => {
      const state = await window.ezterminal.getDaemonSnapshot();
      return window.ezterminal.sendDaemonCommand({
        protocolVersion: state.protocolVersion, commandId, idempotencyKey: commandId, expectedRevision: state.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'profile-runtime' }, type: commandType, payload: commandPayload,
      });
    }, { commandType: type, commandPayload: payload, commandId: `${idPrefix}-${attempt}` });
    if (receipt.ok) return;
    if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
  }
}

/** Saves the Codex project and enables the fake Codex; returns the workspace id. Not measured. */
export async function prepareCodexWorkspace(page, codexRoot) {
  const saved = await page.evaluate(({ root, name }) => window.ezterminal.saveAgentProject({ name, primaryRoot: root, additionalRoots: [], pinned: false }), { root: codexRoot, name: CODEX_PROJECT_NAME });
  if (!saved.ok) throw new Error(saved.reason);
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  await sendDaemonCommand(page, 'provider.enable', {
    providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
    executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames,
    capabilities: probe.capabilities, reviewDigest,
  }, 'profile-enable-codex');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const workspace = await page.evaluate(async (root) => {
      const state = await window.ezterminal.getDaemonSnapshot();
      return state?.workspaces.find((candidate) => candidate.rootPath.toLowerCase() === root.toLowerCase())?.id ?? null;
    }, codexRoot);
    if (workspace) return workspace;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(100);
  }
  throw new Error('The profiled Codex workspace did not appear within 15 s.');
}
