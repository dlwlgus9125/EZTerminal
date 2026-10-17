import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeClaudeProjectDirName } from './claude-history-adapter';

/**
 * Whether Claude Code kept a transcript for this subagent. Claude stores a
 * session's subagents next to it: `<project>/<session>/subagents/agent-<id>.jsonl`.
 * Without the parent's own record there is no evidence either way (undefined).
 */
export function claudeSubagentRecordExists(input: {
  readonly providerId: string;
  readonly workspaceRoot: string;
  readonly parentProviderSessionId: string;
  readonly childProviderSessionId: string;
}, homeDir = os.homedir()): boolean | undefined {
  if (input.providerId !== 'claude') return undefined;
  const safe = /^[A-Za-z0-9-]{1,128}$/u;
  if (!safe.test(input.parentProviderSessionId) || !safe.test(input.childProviderSessionId)) return undefined;
  const project = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDirName(input.workspaceRoot));
  if (!existsSync(path.join(project, `${input.parentProviderSessionId}.jsonl`))) return undefined;
  return existsSync(path.join(project, input.parentProviderSessionId, 'subagents', `agent-${input.childProviderSessionId}.jsonl`));
}
