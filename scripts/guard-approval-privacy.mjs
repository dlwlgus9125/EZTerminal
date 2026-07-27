#!/usr/bin/env node
/**
 * The approval gate admits one piece of provider tool text into the app:
 * `AgentApproval.command`. `src/shared/agent.ts` promises it lives only while
 * the hook is parked, and is never written to disk or to a log.
 *
 * A promise in a comment is not a constraint. This is.
 *
 * Two things are checked, both by reading source rather than by running it:
 *
 *   1. No persistence layer or logger is reachable from the module that holds
 *      the pending approval. The service may not import a store, a JSON file,
 *      or the app's logging surface, and may not call console.* at all.
 *   2. The relay's PowerShell script never reads the fields that carry a
 *      prompt or a transcript out of the provider's stdin.
 *
 * Run: node scripts/guard-approval-privacy.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

// ── 1. the service that holds a pending approval ────────────────────────────
const service = read('src/main/agent-activity-service.ts');

/** Anything that could outlive the process, plus the logger. */
const FORBIDDEN_IMPORTS = [
  './json-file',
  './secure-atomic-file',
  'node:fs',
  'fs/promises',
  'electron-log',
];
for (const specifier of FORBIDDEN_IMPORTS) {
  if (service.includes(`from '${specifier}'`)) {
    failures.push(
      `agent-activity-service.ts imports ${specifier}. It holds AgentApproval.command, `
      + 'which must never reach a file.',
    );
  }
}

if (/\bconsole\.(log|info|warn|error|debug)\s*\(/u.test(service)) {
  failures.push(
    'agent-activity-service.ts calls console.*. A pending approval carries the '
    + 'command text, and a log line is a copy of it that outlives the decision.',
  );
}

// The field must be dropped, not merely stopped being shown, when the window
// closes. `releaseApproval` is where that happens.
if (!/const \{ toolName, risk, requestedAt, expiresAt \} = record\.approval;/u.test(service)) {
  failures.push(
    'agent-activity-service.ts no longer rebuilds an expired approval without '
    + '`command`. Expiry must drop the tool text, not just hide the buttons.',
  );
}

// ── 2. the relay's allowlist ────────────────────────────────────────────────
const relay = read('src/main/agent-hook-relay.ts');
for (const field of ["'prompt'", "'prompt_id'", 'transcript_path']) {
  if (relay.includes(field)) {
    failures.push(`agent-hook-relay.ts reads ${field} out of provider stdin. It must not.`);
  }
}

if (!relay.includes("if ($isApproval) { $sanitized['command'] = Read-ToolInputText $inputObject }")) {
  failures.push(
    'agent-hook-relay.ts no longer restricts tool text to the approval event. '
    + 'Lifecycle hooks are observability and must not quote tool input.',
  );
}

if (failures.length > 0) {
  console.error('guard:approval-privacy FAILED\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('guard:approval-privacy OK — pending approvals cannot reach a file or a log.');
