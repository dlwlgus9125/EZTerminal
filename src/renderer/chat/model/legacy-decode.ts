import { claudeFileChange, decodeFileChanges, type RecordedFileChange } from '../../../shared/conversation-changes';
import type { DaemonTranscriptItem } from '../../../shared/daemon-protocol';
import { toolCategory, toolTarget } from '../../../shared/tool-catalog';
import type { ToolCategory, ToolStatus } from '../../../shared/transcript-payload';
import type { ChatToolFile } from './types';

/**
 * Reads tool information out of transcript items that carry no structured
 * payload: conversations stored before `transcript-payload-v1`, and items from
 * hosts that do not advertise it. The result has the same shape as the payload
 * path so both render identically.
 */

export interface DecodedToolCall {
  readonly name: string;
  readonly category: ToolCategory;
  readonly target?: string;
  readonly command?: string;
  readonly input?: string;
  readonly inputValue?: Readonly<Record<string, unknown>>;
  readonly files?: readonly ChatToolFile[];
  readonly query?: string;
  readonly server?: string;
}

export interface DecodedToolResult {
  readonly status: ToolStatus;
  readonly output?: string;
  readonly query?: string;
  readonly exitCode?: number;
  readonly changes?: readonly RecordedFileChange[];
  readonly files?: readonly ChatToolFile[];
}

const SHELL_WRAPPER = /^"?[^"\s]*(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1\s*$/iu;
const CMD_WRAPPER = /^"?[^"\s]*cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/u;
const SH_WRAPPER = /^"?[^"\s]*(?:bash|sh|zsh)"?\s+-l?c\s+(['"])([\s\S]*)\1\s*$/u;

/** `"C:\...\powershell.exe" -Command 'node --version'` → `node --version`. */
export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const powershell = trimmed.match(SHELL_WRAPPER);
  if (powershell) return powershell[2].replace(/''/gu, "'").trim();
  const sh = trimmed.match(SH_WRAPPER);
  if (sh) return sh[2].trim();
  const cmd = trimmed.match(CMD_WRAPPER);
  if (cmd) return cmd[1].trim();
  return trimmed;
}

function firstLine(value: string, limit = 160): string {
  const line = value.split(/\r?\n/u, 1)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Some adapters stored several pretty-printed objects back to back (`}\n{`). */
function parseObjects(text: string): Record<string, unknown>[] {
  const single = parseObject(text);
  if (single) return [single];
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !/\}\s*\n\s*\{/u.test(trimmed)) return [];
  const parts = trimmed.split(/\}\s*\n\s*\{/u);
  const objects: Record<string, unknown>[] = [];
  parts.forEach((part, index) => {
    const json = `${index === 0 ? '' : '{'}${part}${index === parts.length - 1 ? '' : '}'}`;
    const value = parseObject(json);
    if (value) objects.push(value);
  });
  return objects.length === parts.length ? objects : [];
}

function changeFiles(changes: readonly RecordedFileChange[]): ChatToolFile[] {
  return changes.map((change) => {
    const lines = change.patch.split('\n');
    const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
    return { path: change.path, kind: removed === 0 && added > 0 && change.coverage === 'fragment' ? undefined : 'update', added, removed };
  });
}

function codexFileChangeCall(value: Record<string, unknown>): DecodedToolCall | undefined {
  const changes = Array.isArray(value.changes) ? value.changes : value.path ? [value] : undefined;
  if (!changes) return undefined;
  const files: ChatToolFile[] = [];
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const record = change as Record<string, unknown>;
    if (typeof record.path !== 'string') continue;
    const kindValue = record.kind && typeof record.kind === 'object' ? (record.kind as Record<string, unknown>).type : record.kind;
    const kind = kindValue === 'add' ? 'add' : kindValue === 'delete' ? 'delete' : 'update';
    files.push({ path: record.path, kind });
  }
  if (!files.length) return undefined;
  return {
    name: 'fileChange',
    category: files.every((file) => file.kind === 'add') ? 'write' : 'edit',
    target: files.map((file) => file.path).join(', '),
    files,
  };
}

/** Decode a `tool-call` item that has no payload. */
export function decodeLegacyToolCall(item: DaemonTranscriptItem): DecodedToolCall {
  const text = item.text;
  if (text.startsWith('$ ')) {
    const command = unwrapShellCommand(text.slice(2));
    return { name: 'commandExecution', category: 'command', command, target: firstLine(command), input: command };
  }
  const objects = parseObjects(text);
  const json = objects.length === 1 ? objects[0] : undefined;
  if (json?.type === 'webSearch') {
    const query = typeof json.query === 'string' && json.query ? json.query : undefined;
    return { name: 'webSearch', category: 'web', ...(query ? { query, target: query } : {}), input: text };
  }
  if (objects.length) {
    const fileChange = codexFileChangeCall(objects.length === 1 ? objects[0] : { changes: objects });
    if (fileChange) return { ...fileChange, input: text };
  }
  // Claude: `Name\n{json}` (Write historically put the file content after the name).
  const newline = text.indexOf('\n');
  const name = (newline < 0 ? text : text.slice(0, newline)).trim();
  const body = newline < 0 ? '' : text.slice(newline + 1);
  // MCP/dynamic tools: `server/tool: status\n...`.
  const mcp = name.match(/^([^\s/:]+)\/([^\s:]+):\s*\w+$/u);
  if (mcp) {
    return { name: mcp[2], category: 'mcp', server: mcp[1], target: `${mcp[1]} / ${mcp[2]}`, input: body };
  }
  if (!/^[A-Za-z][\w.-]{0,80}$/u.test(name)) {
    return { name: 'tool', category: 'other', input: text };
  }
  const inputValue = parseObject(body);
  const category = toolCategory(name);
  const target = inputValue ? toolTarget(name, inputValue) : undefined;
  const command = category === 'command' && typeof inputValue?.command === 'string' ? inputValue.command : undefined;
  const change = inputValue ? claudeFileChange(name, inputValue) : undefined;
  return {
    name,
    category,
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
    input: body,
    ...(inputValue ? { inputValue } : {}),
    ...(change ? { files: changeFiles([change]) } : {}),
  };
}

/** Decode a `tool-result` item that has no payload. */
export function decodeLegacyToolResult(item: DaemonTranscriptItem): DecodedToolResult {
  const text = item.text;
  const changes = decodeFileChanges(text);
  if (changes.length) return { status: 'completed', changes, files: changeFiles(changes) };
  if (/^Denied by the user\.?/u.test(text) || /^Command declined\.?$/u.test(text)) return { status: 'denied', output: text };
  if (/^Command failed\.?$/u.test(text)) return { status: 'failed', output: text };
  const exit = text.match(/^Exit code (\d+)/u);
  if (exit && exit[1] !== '0') return { status: 'failed', output: text, exitCode: Number(exit[1]) };
  if (/^Command interrupted\.?$/u.test(text)) return { status: 'interrupted', output: text };
  const web = /^\{\s*"type":\s*"webSearch"/u.test(text.trimStart()) ? parseObject(text) : undefined;
  if (web?.type === 'webSearch') return webResult(web);
  return { status: 'completed', output: text };
}

function webResult(value: Record<string, unknown>): DecodedToolResult {
  const query = typeof value.query === 'string' && value.query ? value.query.replace(/\s*\.\.\.$/u, '') : undefined;
  const results = Array.isArray(value.results) ? value.results : [];
  const lines = results.flatMap((result, index) => {
    if (!result || typeof result !== 'object') return [];
    const record = result as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    return title || url ? [`${index + 1}. ${title ?? url}${title && url ? ` — ${url}` : ''}`] : [];
  });
  return { status: 'completed', ...(query ? { query } : {}), output: lines.join('\n') || (query ?? '') };
}
