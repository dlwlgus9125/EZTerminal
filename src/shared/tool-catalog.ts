import type { ToolCategory } from './transcript-payload';

/**
 * Provider tool names → presentation category and a short target.
 *
 * Shared by the adapters (to fill `ToolPayload.category`/`target`) and by the
 * renderer's legacy decoder (old items carry only `Name\n{json}` text), so a
 * stored conversation and a live one present the same way.
 */

const CLAUDE_TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  Read: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  LS: 'list',
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  PowerShell: 'command',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
  ToolSearch: 'other',
};

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  return CLAUDE_TOOL_CATEGORIES[name] ?? 'other';
}

/** `mcp__server__tool` → `{ server, tool }`. */
export function splitMcpToolName(name: string): { readonly server: string; readonly tool: string } | undefined {
  const match = name.match(/^mcp__(.+?)__(.+)$/u);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

function stringField(input: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstLine(value: string, limit = 160): string {
  const line = value.split(/\r?\n/u, 1)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function urlTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

/** A short subject for the tool line: path, pattern, command summary, or URL. */
export function toolTarget(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  switch (toolCategory(name)) {
    case 'read':
    case 'edit':
    case 'write':
      return stringField(record, 'file_path', 'notebook_path', 'path');
    case 'search': {
      const pattern = stringField(record, 'pattern', 'query');
      const scope = stringField(record, 'path', 'glob');
      return pattern ? (scope ? `${pattern} · ${scope}` : pattern) : scope;
    }
    case 'list':
      return stringField(record, 'path');
    case 'command': {
      const command = stringField(record, 'command');
      return command ? firstLine(command) : stringField(record, 'description');
    }
    case 'web': {
      const url = stringField(record, 'url');
      return url ? urlTarget(url) : stringField(record, 'query');
    }
    case 'agent':
      return stringField(record, 'description', 'subagent_type');
    case 'mcp': {
      const parts = splitMcpToolName(name);
      return parts ? `${parts.server} / ${parts.tool}` : undefined;
    }
    default:
      return undefined;
  }
}
