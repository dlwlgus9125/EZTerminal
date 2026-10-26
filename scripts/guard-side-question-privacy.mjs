#!/usr/bin/env node
/**
 * /btw promises that a side question and its answer are never stored, logged, or turned into a
 * turn: they live in the asking surface's memory and in one provider control request.
 *
 * A promise in a comment is not a constraint. This is. Checked by reading source:
 *
 *   1. The modules that carry question/answer text import no store, file or logger, never call
 *      console.*, and never touch browser storage or the session view-state store.
 *   2. The provider and runtime `askSideQuestion` bodies never append a transcript item, emit an
 *      app event, commit a transition, or attach/resume a provider session.
 *   3. /btw is not a daemon command (everything through the command outbox is persisted), and the
 *      remote bridge's `side-question-ask` case never executes one.
 *
 * Run: node scripts/guard-side-question-privacy.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

// ── 1. modules holding side question text ──────────────────────────────────
const rendererDirectory = 'src/renderer/side-question';
const textModules = [
  'src/shared/agent-side-question.ts',
  'src/main/agent-side-question-service.ts',
  'src/main/agent-side-question-ipc.ts',
  ...readdirSync(path.join(root, rendererDirectory))
    .filter((name) => /\.(ts|tsx)$/u.test(name) && !/\.(test|stories)\.tsx?$/u.test(name))
    .map((name) => `${rendererDirectory}/${name}`),
];
const FORBIDDEN_IMPORT = /from\s+['"](?:node:fs|fs|fs\/promises|electron-log|[./]*(?:json-file|secure-atomic-file|daemon-store|session-view-state|chat-view-state|chat-state[^'"]*|[^'"]*recovery[^'"]*))['"]/u;
const FORBIDDEN_CALL = /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bsaveSessionViewState\b|\bwriteFile(?:Sync)?\s*\(/u;
for (const file of textModules) {
  const source = read(file);
  const imported = source.match(FORBIDDEN_IMPORT);
  if (imported) failures.push(`${file} imports ${imported[0]}. Side question text must never reach a store, a file or a log.`);
  const called = source.match(FORBIDDEN_CALL);
  if (called) failures.push(`${file} uses ${called[0].trim()}. Side question text must stay in memory and out of logs.`);
}

// ── 2. provider and runtime bodies ─────────────────────────────────────────
/** The brace-matched body of the first method definition named `name` in `source`. */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return undefined;
  const open = source.slice(start).search(/\{\r?\n/u);
  if (open < 0) return undefined;
  let depth = 0;
  for (let index = start + open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start + open, index + 1);
  }
  return undefined;
}

const bodies = [
  { file: 'src/main/claude-provider-adapter.ts', signature: 'async askSideQuestion(', required: true,
    forbidden: [/appendTranscript\s*\(/u, /this\.emit\s*\(/u, /emitProviderError\s*\(/u, /this\.report\s*\(/u] },
  { file: 'src/main/codex-provider-adapter.ts', signature: 'async askSideQuestion(', required: false,
    forbidden: [/appendTranscript\s*\(/u, /this\.emit\s*\(/u, /emitProviderError\s*\(/u, /handleCodexError\s*\(/u] },
  { file: 'src/main/daemon-agent-runtime.ts', signature: 'async askSideQuestion(', required: true,
    forbidden: [/this\.transition\s*\(/u, /rehydrateSession\s*\(/u, /\.createSession\s*\(/u, /\.resumeSession\s*\(/u, /this\.report\s*\(/u, /setProviderAttached\s*\(/u] },
];
for (const { file, signature, required, forbidden } of bodies) {
  const body = methodBody(read(file), signature);
  if (!body) {
    if (required) failures.push(`${file} has no \`${signature}\` body to check.`);
    continue;
  }
  for (const pattern of forbidden) {
    if (pattern.test(body)) failures.push(`${file} askSideQuestion calls ${pattern.source}. A side question must leave nothing behind.`);
  }
}

// ── 3. not a daemon command, and the bridge never executes one for it ──────
const protocol = read('src/shared/daemon-protocol.ts');
const commandTypes = protocol.slice(protocol.indexOf('export const DAEMON_COMMAND_TYPES'), protocol.indexOf('] as const', protocol.indexOf('export const DAEMON_COMMAND_TYPES')));
if (/side|btw/iu.test(commandTypes)) failures.push('DAEMON_COMMAND_TYPES lists a side question command. Daemon commands are persisted in the outbox.');
const bridge = read('src/main/remote-bridge.ts');
const askCase = methodBody(bridge, "case 'side-question-ask':");
if (!askCase) failures.push("remote-bridge.ts has no `case 'side-question-ask'` block to check.");
else if (/\bexecute\s*\(/u.test(askCase)) failures.push("remote-bridge.ts `side-question-ask` executes a command. It must call the side question host only.");

if (failures.length) {
  console.error(`Side question privacy guard failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  process.exit(1);
}
console.log(`Side question privacy guard passed (${textModules.length} modules, ${bodies.length} method bodies, daemon commands, bridge).`);
