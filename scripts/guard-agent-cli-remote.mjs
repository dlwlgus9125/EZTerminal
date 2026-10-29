#!/usr/bin/env node
/**
 * The AI management program update (`npm install -g` of Claude Code or Codex) runs only from the
 * PC app's own settings. A phone may manage plugins, marketplaces, MCP servers and skills, but it
 * can never install a program on the PC.
 *
 * A promise in a comment is not a constraint. This is. Checked by reading source:
 *
 *   1. No remote surface names the update: the remote protocol, the bridge, its validation and
 *      every phone module carry no `agent-cli` request and no CLI client.
 *   2. The update service is reachable only through the desktop IPC channels in main.ts, and those
 *      check the desktop session principal.
 *
 * Run: node scripts/guard-agent-cli-remote.mjs        (checks the source tree)
 *      node scripts/guard-agent-cli-remote.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_FILES = ['src/shared/remote-protocol.ts', 'src/main/remote-bridge.ts', 'src/main/remote-message-validation.ts'];
const FORBIDDEN_REMOTE = /agent-cli[:-]|AgentCliClient|AgentCliUpdateService|agentCliUpdate\b|agentCliStatus\b/u;

/** @returns {string[]} failures for one file's text */
export function remoteFailures(file, source) {
  const match = source.match(FORBIDDEN_REMOTE);
  return match ? [`${file} mentions "${match[0]}". The program update must stay on the PC; no remote request may reach it.`] : [];
}

/** @returns {string[]} failures for main.ts's IPC wiring */
export function desktopFailures(source) {
  const failures = [];
  for (const channel of ['agent-cli:status', 'agent-cli:update']) {
    const handler = new RegExp(`ipcMain\\.handle\\('${channel}',[\\s\\S]{0,240}?resolveDesktopSessionPrincipal`, 'u');
    if (!handler.test(source)) failures.push(`main.ts: the ${channel} handler must check resolveDesktopSessionPrincipal before running.`);
  }
  if (/agentCliUpdate\w*\s*:\s*agentCliUpdate/u.test(source) || /Source:\s*agentCliUpdate/u.test(source)) {
    failures.push('main.ts hands the program update service to another surface. It is desktop IPC only.');
  }
  return failures;
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'android' && name !== 'dist') files.push(...walk(full));
    } else if (/\.(ts|tsx)$/u.test(name) && !/\.(test|stories)\.tsx?$/u.test(name)) files.push(full);
  }
  return files;
}

function selfTest() {
  const remote = remoteFailures('x.ts', "case 'agent-cli-update': return update();");
  const clean = remoteFailures('x.ts', "case 'agent-host-extensions-list': return list();");
  const open = desktopFailures("ipcMain.handle('agent-cli:status', async () => service.status());");
  const closed = desktopFailures([
    "ipcMain.handle('agent-cli:status', async (event, clientId) => { if (!resolveDesktopSessionPrincipal(event, clientId)) return null; });",
    "ipcMain.handle('agent-cli:update', async (event, clientId) => { if (!resolveDesktopSessionPrincipal(event, clientId)) return null; });",
  ].join('\n'));
  const problems = [];
  if (remote.length !== 1) problems.push('a remote agent-cli request was not caught');
  if (clean.length !== 0) problems.push('a PC-wide extension request was flagged');
  if (open.length === 0) problems.push('an unguarded IPC handler was not caught');
  if (closed.length !== 0) problems.push('guarded IPC handlers were flagged');
  if (problems.length) {
    console.error(`guard:agent-cli-remote self-test FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('guard:agent-cli-remote self-test OK');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const failures = [];
  const files = [...REMOTE_FILES.map((file) => path.join(root, file)), ...walk(path.join(root, 'mobile', 'src'))];
  for (const file of files) failures.push(...remoteFailures(path.relative(root, file), readFileSync(file, 'utf8')));
  failures.push(...desktopFailures(readFileSync(path.join(root, 'src', 'main', 'main.ts'), 'utf8')));
  if (failures.length) {
    console.error(`guard:agent-cli-remote FAILED:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`guard:agent-cli-remote OK: ${files.length} remote and phone files and the desktop IPC checked.`);
}
