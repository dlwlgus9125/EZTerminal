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
 * Only `gateway start|stop|restart|install|uninstall` invocations are argv-
 * recorded into `state.cliCalls` — `config get` runs TWO PROCESSES
 * CONCURRENTLY (OpenClawService.getCoreConfig's Promise.all over both
 * allowlisted keys) and never mutates `state.config`, so recording it too
 * would race on this lockless read-modify-write file without buying any
 * assertion the e2e specs need.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.EZTERM_E2E_OPENCLAW_STATE;
const argv = process.argv.slice(2);

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state));
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
