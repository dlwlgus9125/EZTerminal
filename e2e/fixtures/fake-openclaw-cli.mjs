#!/usr/bin/env node
/**
 * Fake `openclaw` CLI (openclaw-management M2 e2e). Honors exactly the
 * subcommands OpenClawService.execCli actually spawns (see openclaw-service.ts):
 * `gateway start|stop|restart`, `config get <key> --json`,
 * `config set <key> <value> --strict-json`, `config file`. Reads/writes a
 * shared JSON state file (path in env `EZTERM_E2E_OPENCLAW_STATE`) so the
 * fake gateway process (fake-openclaw-gateway.mjs) and this CLI agree on
 * running/config — mirrors the real CLI's exit-code/message framing verified
 * in M0 (docs/research/2026-07-12-openclaw-stage0.md ①).
 *
 * Also honors `gateway install|uninstall` (task #9, autostart toggle) — same
 * argv-recording as start/stop/restart, no state mutation (autostart is
 * orthogonal to `state.running`).
 *
 * `gateway start|stop|restart|install|uninstall` and `config set` invocations
 * are argv-recorded into `state.cliCalls` — `config set` is safe to record
 * because OpenClawPanel.saveConfig awaits each key sequentially (never
 * concurrent). `config get` is NOT recorded: it runs TWO PROCESSES
 * CONCURRENTLY (OpenClawService.getCoreConfig's Promise.all over both
 * allowlisted keys) and never mutates `state.config`, so recording it too
 * would race on this lockless read-modify-write file without buying any
 * assertion the e2e specs need.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const statePath = process.env.EZTERM_E2E_OPENCLAW_STATE;
const argv = process.argv.slice(2);

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  // The gateway polls this file concurrently. Writing in place briefly exposes
  // an empty/partial JSON document and can crash that fixture process exactly
  // while a lifecycle transition is being asserted. Publish a complete sibling
  // file atomically so every reader observes either the old or the new state.
  const pendingPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(pendingPath, JSON.stringify(state));
    renameSync(pendingPath, statePath);
  } finally {
    rmSync(pendingPath, { force: true });
  }
}

const [group, sub, ...rest] = argv;

if (group === 'gateway' && (sub === 'start' || sub === 'stop' || sub === 'restart')) {
  const state = readState();
  state.cliCalls = state.cliCalls ?? [];
  state.cliCalls.push({ argv, at: Date.now() });
  state.running = sub !== 'stop';
  writeState(state);
  process.exit(0);
}

if (group === 'gateway' && (sub === 'install' || sub === 'uninstall')) {
  const state = readState();
  state.cliCalls = state.cliCalls ?? [];
  state.cliCalls.push({ argv, at: Date.now() });
  writeState(state);
  process.exit(0);
}

if (group === 'config' && sub === 'get') {
  const key = rest[0];
  const state = readState();
  const value = state.config?.[key];
  if (value === undefined) {
    process.stderr.write(`Config path not found: ${key}. Run openclaw config validate to inspect config shape.\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

if (group === 'config' && sub === 'set') {
  const [key, value] = rest;
  const state = readState();
  state.config = state.config ?? {};
  state.config[key] = value;
  state.cliCalls = state.cliCalls ?? [];
  state.cliCalls.push({ argv, at: Date.now() });
  writeState(state);
  process.stdout.write(`Updated ${key}. Restart the gateway to apply.\n`);
  process.exit(0);
}

if (group === 'config' && sub === 'file') {
  const state = readState();
  process.stdout.write(`${state.configFilePath ?? ''}\n`);
  process.exit(0);
}

process.stderr.write(`fake-openclaw-cli: unhandled invocation: ${argv.join(' ')}\n`);
process.exit(1);
