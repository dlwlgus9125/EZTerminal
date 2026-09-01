/**
 * Local Claude Code history, read straight off the provider's own store.
 *
 * Unlike Codex there is no app-server to ask, so this adapter reads
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` itself. Two properties of
 * that store shape every decision here (both verified against the installed CLI,
 * 2.1.220, not assumed):
 *
 *  - Transcripts are large. Real files reach 11.6 MB across 5,333 lines, with
 *    single lines of 221 KB when a tool result is inlined. Nothing below ever
 *    reads a whole transcript to answer a *list* query, and opening a session
 *    reads only the byte range of the turns actually being shown.
 *  - The directory name is a lossy encoding of the cwd (every non-alphanumeric
 *    character becomes `-`), so it is never decoded back. A session's real root
 *    comes from the `cwd` field inside the file, or from the project root the
 *    search started at.
 *
 * Scope: this adapter only ever looks inside directories derived from roots it
 * is handed. It has no "list every Claude project" path, by design — the local
 * project index is manual + terminal-observed work only.
 */
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  MAX_AGENT_HISTORY_PAGE_SIZE,
  MAX_AGENT_TRANSCRIPT_PAGE_SIZE,
  type AgentTranscriptEntry,
  type AgentTranscriptPage,
  type AgentTranscriptTurn,
} from '../shared/agent-history';
import { hasProjectPathControlCharacters } from '../shared/project-workspace';
import { quoteEzArgument } from '../shared/quote-ez-argument';
import type { AgentPersonaLaunch } from '../shared/agent-team';
import type {
  AgentHistoryProviderAdapter,
  AgentResumeCommand,
  ProviderFileChangeRecord,
  ProviderFileChangeSet,
  ProviderHistorySession,
  ProviderHistorySessionPage,
  ProviderSessionQuery,
} from './agent-history-provider';

type JsonObject = Record<string, unknown>;

/** Claude's own cap before it truncates a project directory name and appends a hash. */
const MAX_PROJECT_DIR_NAME = 200;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Enough for the first envelope record, which is where a session's cwd lives. */
const HEAD_SCAN_BYTES = 64 * 1024;
/** Corrupt-file guard for the shared prompt index; the real file is ~1 MB. */
const MAX_PROMPT_INDEX_BYTES = 64 * 1024 * 1024;
/** Ceiling on one transcript page's read. At least one turn is always returned. */
const MAX_TRANSCRIPT_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_INDEXED_TRANSCRIPTS = 8;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseRecord(line: string): JsonObject | null {
  if (line.length === 0 || line.charCodeAt(0) !== 0x7b) return null;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function isoTimestamp(value: unknown): number {
  const text = asString(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Concatenated `text` of a content value, ignoring tool plumbing blocks. */
function messageText(value: unknown, max = 20_000): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }
    const block = asObject(entry);
    if (!block) continue;
    const type = asString(block.type);
    if (type !== null && type !== 'text' && type !== 'thinking') continue;
    const text = asString(block.text) ?? asString(block.thinking);
    if (text) parts.push(text);
  }
  return parts.join('\n').slice(0, max);
}

function opaqueTranscriptId(prefix: 'turn' | 'item', source: string): string {
  return `${prefix}_${createHash('sha256').update(source).digest('hex').slice(0, 20)}`;
}

/**
 * Claude's project directory name: every non-alphanumeric character becomes a
 * single `-` (a 1:1 substitution, so runs are preserved and case is kept), and
 * anything past 200 characters is truncated and suffixed with a base-36 rolling
 * hash of the ORIGINAL path.
 */
export function encodeClaudeProjectDirName(cwd: string): string {
  const replaced = cwd.replace(/[^a-zA-Z0-9]/gu, '-');
  if (replaced.length <= MAX_PROJECT_DIR_NAME) return replaced;
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  }
  return `${replaced.slice(0, MAX_PROJECT_DIR_NAME)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Directories that can hold sessions for `root`: the exact encoding, plus every
 * truncation sibling sharing its 200-character prefix. Claude encodes the cwd
 * exactly as the process saw it, so `c:\x` and `C:\X` are different directories
 * for the same folder — Windows matches case-insensitively rather than silently
 * losing those sessions.
 */
export function claudeProjectDirNames(
  projectEntries: readonly string[],
  root: string,
): readonly string[] {
  const encoded = encodeClaudeProjectDirName(root);
  const names: string[] = [];
  const sameName = process.platform === 'win32'
    ? (name: string): boolean =>
      name.toLocaleLowerCase('en-US') === encoded.toLocaleLowerCase('en-US')
    : (name: string): boolean => name === encoded;
  for (const name of projectEntries) {
    if (sameName(name)) names.push(name);
  }
  if (encoded.length > MAX_PROJECT_DIR_NAME) {
    const prefix = `${encoded.slice(0, MAX_PROJECT_DIR_NAME)}-`;
    for (const name of projectEntries) {
      if (name.startsWith(prefix) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * A record the user actually typed. `isMeta` alone is not enough: slash
 * commands, `<local-command-stdout>` echoes and caveat notices all arrive as
 * plain `type:"user"` records. `origin.kind === 'human'` is the discriminator,
 * and tool results never carry an `origin` at all.
 */
function isHumanPrompt(record: JsonObject): boolean {
  return (
    record.type === 'user'
    && record.isSidechain !== true
    && record.isMeta !== true
    && record.isCompactSummary !== true
    && record.isVisibleInTranscriptOnly !== true
    && asObject(record.origin)?.kind === 'human'
  );
}

function activityKind(toolName: string): Extract<AgentTranscriptEntry, { type: 'activity' }>['kind'] {
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
    case 'PowerShell':
      return 'command';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'file-change';
    case 'WebSearch':
    case 'WebFetch':
      return 'web-search';
    case 'Agent':
    case 'Task':
      return 'subagent';
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return 'plan';
    default:
      return 'tool';
  }
}

function toolSummary(toolName: string, input: unknown): string {
  const fields = asObject(input);
  const detail = fields
    ? asString(fields.command)
      ?? asString(fields.file_path)
      ?? asString(fields.notebook_path)
      ?? asString(fields.query)
      ?? asString(fields.pattern)
      ?? asString(fields.url)
      ?? asString(fields.description)
    : null;
  const summary = detail ? `${toolName}: ${detail}` : toolName;
  return summary.length > 500 ? `${summary.slice(0, 497)}…` : summary;
}

function structuredToolPath(toolName: string, input: unknown): string | null {
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'NotebookEdit') return null;
  const fields = asObject(input);
  const candidate = asString(toolName === 'NotebookEdit' ? fields?.notebook_path : fields?.file_path);
  if (!candidate || candidate.length > 4096 || hasProjectPathControlCharacters(candidate)) return null;
  return candidate;
}

function assistantEntries(record: JsonObject, turnId: string, index: number): AgentTranscriptEntry[] {
  const content = asObject(record.message)?.content;
  if (!Array.isArray(content)) return [];
  const entries: AgentTranscriptEntry[] = [];
  content.forEach((value, blockIndex) => {
    const block = asObject(value);
    if (!block) return;
    const id = opaqueTranscriptId('item', `${turnId}:${index}:${blockIndex}`);
    switch (asString(block.type)) {
      case 'text': {
        const markdown = asString(block.text) ?? '';
        if (markdown.trim()) {
          entries.push({ type: 'message', id, role: 'assistant', markdown: markdown.slice(0, 20_000) });
        }
        break;
      }
      case 'thinking':
        entries.push({
          type: 'activity',
          id,
          kind: 'reasoning',
          summary: (asString(block.thinking) ?? 'Reasoning').slice(0, 2_000),
        });
        break;
      case 'tool_use': {
        const name = asString(block.name) ?? 'Tool';
        const kind = activityKind(name);
        const changedPath = structuredToolPath(name, block.input);
        entries.push({
          type: 'activity',
          id,
          kind,
          summary: toolSummary(name, block.input),
          ...(changedPath ? { changedPaths: [changedPath] } : {}),
        });
        break;
      }
      default:
        break;
    }
  });
  return entries;
}

/**
 * Slash commands and their echoes arrive as ordinary `type:"user"` records with
 * an XML-ish wrapper instead of a flag. They are CLI plumbing, not conversation.
 */
function isCommandPlumbing(text: string): boolean {
  return /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/u
    .test(text);
}

function userEntries(record: JsonObject, turnId: string, index: number): AgentTranscriptEntry[] {
  const content = asObject(record.message)?.content;
  const id = opaqueTranscriptId('item', `${turnId}:${index}`);
  if (typeof content === 'string') {
    const markdown = content.trim();
    if (!markdown || isCommandPlumbing(markdown)) return [];
    return [{ type: 'message', id, role: 'user', markdown: markdown.slice(0, 20_000) }];
  }
  if (!Array.isArray(content)) return [];
  const entries: AgentTranscriptEntry[] = [];
  content.forEach((value, blockIndex) => {
    const block = asObject(value);
    if (!block) return;
    const blockId = opaqueTranscriptId('item', `${turnId}:${index}:${blockIndex}`);
    const type = asString(block.type);
    if (type === 'text') {
      const markdown = (asString(block.text) ?? '').trim();
      if (markdown) {
        entries.push({ type: 'message', id: blockId, role: 'user', markdown: markdown.slice(0, 20_000) });
      }
      return;
    }
    if (type !== 'tool_result') return;
    // The result body can be hundreds of KB. Show that it happened and how it
    // ended; the full text belongs to the provider's own transcript view.
    entries.push({
      type: 'activity',
      id: blockId,
      kind: 'tool',
      summary: messageText(block.content, 1_000).trim() || 'Tool result',
      status: block.is_error === true ? 'error' : 'completed',
    });
  });
  return entries;
}

function transcriptEntries(record: JsonObject, turnId: string, index: number): AgentTranscriptEntry[] {
  if (record.isSidechain === true) return [];
  switch (record.type) {
    case 'user':
      if (record.isMeta === true || record.isVisibleInTranscriptOnly === true) return [];
      return userEntries(record, turnId, index);
    case 'assistant':
      return assistantEntries(record, turnId, index);
    case 'system':
      return record.subtype === 'compact_boundary'
        ? [{
          type: 'activity',
          id: opaqueTranscriptId('item', `${turnId}:${index}`),
          kind: 'tool',
          summary: 'Conversation compacted',
        }]
        : [];
    default:
      // mode / permission-mode / ai-title / agent-name / last-prompt /
      // attachment / file-history-* / queue-operation carry no conversation.
      return [];
  }
}

async function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Walks the file one line at a time, reporting each line's absolute byte offset.
 * Only the offsets are ever retained by callers, and `for await` yields between
 * chunks so a multi-megabyte transcript does not stall the main process.
 */
async function streamLines(
  filePath: string,
  onLine: (line: string, offset: number) => void,
): Promise<void> {
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let lineStart = 0;
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    let cursor = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline < 0) {
        if (cursor < chunk.length) {
          const tail = chunk.subarray(cursor);
          pending.push(tail);
          pendingBytes += tail.length;
        }
        break;
      }
      const segment = chunk.subarray(cursor, newline);
      const lineBytes = pendingBytes + segment.length;
      let line: string;
      if (pendingBytes > 0) {
        pending.push(segment);
        line = Buffer.concat(pending).toString('utf8');
        pending.length = 0;
        pendingBytes = 0;
      } else {
        line = segment.toString('utf8');
      }
      onLine(line, lineStart);
      lineStart += lineBytes + 1;
      cursor = newline + 1;
    }
  }
  if (pendingBytes > 0) onLine(Buffer.concat(pending).toString('utf8'), lineStart);
}

interface SessionFile {
  readonly filePath: string;
  readonly root: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface TurnIndex {
  /** Byte offset of the line that starts each rendered turn, oldest first. */
  readonly offsets: readonly number[];
  readonly size: number;
}

interface PromptIndexEntry {
  readonly display: string;
  readonly createdAt: number;
  /** True while only slash commands have been seen, so real prose can replace it. */
  readonly slashOnly: boolean;
}

interface PromptIndex {
  readonly bySession: ReadonlyMap<string, PromptIndexEntry>;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ClaudeHistoryAdapterOptions {
  /**
   * Defaults to `os.homedir()` — the same resolution Claude Code itself uses to
   * find `~/.claude`, and unlike Electron's `app.getPath('home')` (which reads
   * the Windows shell profile path directly) it honours `USERPROFILE`/`HOME`,
   * so the E2E harness can point a launched app at a fixture store.
   */
  readonly homeDir?: string;
}

export class ClaudeHistoryAdapter implements AgentHistoryProviderAdapter {
  readonly provider = 'claude' as const;

  private readonly claudeDirectory: string;
  private readonly projectsDirectory: string;
  private readonly turnIndexes = new Map<string, TurnIndex>();
  private promptIndex: PromptIndex | null = null;

  constructor(options: ClaudeHistoryAdapterOptions = {}) {
    this.claudeDirectory = path.join(options.homeDir ?? os.homedir(), '.claude');
    this.projectsDirectory = path.join(this.claudeDirectory, 'projects');
  }

  async listSessions(query: ProviderSessionQuery): Promise<ProviderHistorySessionPage> {
    const limit = Math.max(1, Math.min(MAX_AGENT_HISTORY_PAGE_SIZE, Math.trunc(query.limit)));
    const files = await this.collectSessionFiles(query.roots);
    const offset = Number.parseInt(query.cursor ?? '', 10);
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const selected = files.slice(start, start + limit);
    const prompts = selected.length > 0 ? await this.readPromptIndex() : null;
    const items: ProviderHistorySession[] = [];
    for (const file of selected) {
      const session = await this.readSessionSummary(file, prompts);
      if (session) items.push(session);
    }
    const next = start + selected.length;
    return { items, nextCursor: next < files.length ? String(next) : null };
  }

  async readTranscript(
    privateId: string,
    cursor?: string,
    limit = MAX_AGENT_TRANSCRIPT_PAGE_SIZE,
  ): Promise<AgentTranscriptPage> {
    const boundedLimit = Math.max(1, Math.min(MAX_AGENT_TRANSCRIPT_PAGE_SIZE, Math.trunc(limit)));
    const empty: AgentTranscriptPage = {
      historyId: '',
      provider: this.provider,
      turns: [],
      nextCursor: null,
    };
    const index = await this.turnIndex(privateId);
    if (!index || index.offsets.length === 0) return empty;

    const end = cursor === undefined
      ? index.offsets.length
      : index.offsets.indexOf(Number.parseInt(cursor, 10));
    if (end <= 0) return empty;

    // Walk back from the newest shown turn, stopping at the page size or the
    // read ceiling — whichever comes first. One turn is always included.
    let start = end;
    let bytes = 0;
    while (start > 0 && end - start < boundedLimit) {
      const previous = start - 1;
      const turnEnd = start < index.offsets.length ? index.offsets[start]! : index.size;
      const span = turnEnd - index.offsets[previous]!;
      if (bytes > 0 && bytes + span > MAX_TRANSCRIPT_RANGE_BYTES) break;
      bytes += span;
      start = previous;
    }

    const rangeStart = index.offsets[start]!;
    const rangeEnd = end < index.offsets.length ? index.offsets[end]! : index.size;
    const buffer = await readRange(privateId, rangeStart, rangeEnd - rangeStart);
    const turns: AgentTranscriptTurn[] = [];
    for (let position = start; position < end; position += 1) {
      const from = index.offsets[position]! - rangeStart;
      const to = (position + 1 < index.offsets.length
        ? Math.min(index.offsets[position + 1]!, rangeEnd)
        : rangeEnd) - rangeStart;
      turns.push(this.buildTurn(buffer.toString('utf8', from, Math.max(from, to)), index.offsets[position]!));
    }
    return {
      historyId: '',
      provider: this.provider,
      turns,
      // The oldest turn shown: the next page ends where this one starts.
      nextCursor: start > 0 ? String(rangeStart) : null,
    };
  }

  async readFileChanges(privateId: string, turnId?: string): Promise<ProviderFileChangeSet | null> {
    const index = await this.turnIndex(privateId);
    if (!index || index.offsets.length === 0) return null;
    const selectedIndex = turnId === undefined
      ? index.offsets.length - 1
      : index.offsets.findIndex((offset) => opaqueTranscriptId('turn', String(offset)) === turnId);
    if (selectedIndex < 0) return null;
    const start = index.offsets[selectedIndex]!;
    const end = selectedIndex + 1 < index.offsets.length
      ? index.offsets[selectedIndex + 1]!
      : index.size;
    const length = end - start;
    if (length <= 0 || length > MAX_TRANSCRIPT_RANGE_BYTES) return null;
    const text = (await readRange(privateId, start, length)).toString('utf8');
    const toolUses = new Map<string, { readonly name: string; readonly input: JsonObject }>();
    const successfulResults = new Set<string>();
    let complete = false;

    for (const line of text.split('\n')) {
      const record = parseRecord(line);
      if (!record || record.isSidechain === true) continue;
      const message = asObject(record.message);
      if (record.type === 'assistant') {
        const stopReason = asString(message?.stop_reason);
        if (stopReason === 'end_turn' || stopReason === 'stop_sequence') complete = true;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const value of content) {
          const block = asObject(value);
          if (asString(block?.type) !== 'tool_use') continue;
          const id = asString(block?.id);
          const name = asString(block?.name);
          const input = asObject(block?.input);
          if (id && name && input) toolUses.set(id, { name, input });
        }
      } else if (record.type === 'user') {
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const value of content) {
          const block = asObject(value);
          if (asString(block?.type) !== 'tool_result' || block?.is_error === true) continue;
          const toolUseId = asString(block?.tool_use_id);
          if (toolUseId) successfulResults.add(toolUseId);
        }
      }
    }
    if (!complete) return null;

    const changes: ProviderFileChangeRecord[] = [];
    for (const [id, tool] of toolUses) {
      if (!successfulResults.has(id)) continue;
      const filePath = asString(tool.input.file_path) ?? asString(tool.input.notebook_path);
      if (!filePath || filePath.length > 4096 || hasProjectPathControlCharacters(filePath)) continue;
      if (tool.name === 'Edit') {
        const original = asString(tool.input.old_string);
        const modified = asString(tool.input.new_string);
        if (original === null || modified === null) continue;
        changes.push({
          path: filePath,
          kind: 'modified',
          operation: 'edit',
          ...(tool.input.replace_all === true ? { replaceAll: true } : {}),
          original: original.slice(0, 1024 * 1024),
          modified: modified.slice(0, 1024 * 1024),
        });
      } else if (tool.name === 'Write') {
        const modified = asString(tool.input.content);
        if (modified === null) continue;
        changes.push({
          path: filePath,
          // Claude's Write tool can create or overwrite. The transcript does
          // not prove which happened, so "modified" avoids a false creation
          // claim while still attributing the successful write.
          kind: 'modified',
          operation: 'write',
          original: '',
          modified: modified.slice(0, 1024 * 1024),
        });
      } else if (tool.name === 'NotebookEdit') {
        const modified = asString(tool.input.new_source) ?? asString(tool.input.source);
        if (modified === null) continue;
        changes.push({
          path: filePath,
          kind: 'modified',
          operation: 'notebook-edit',
          original: '',
          modified: modified.slice(0, 1024 * 1024),
        });
      }
      if (changes.length >= 200) break;
    }
    return {
      provider: this.provider,
      turnId: opaqueTranscriptId('turn', String(start)),
      changes,
    };
  }

  /**
   * Claude has no "run in this directory" flag, so the primary root is NOT on
   * the command line — the caller must start the shell session there
   * (`AgentResumeBootstrap.cwd`). The first message is delivered as PTY input,
   * never as argv: `--resume` takes an optional value and would swallow a
   * trailing prompt as a session id.
   */
  buildResumeCommand(privateId: string, roots: readonly string[]): AgentResumeCommand | null {
    const sessionId = path.basename(privateId, '.jsonl');
    const [primaryRoot, ...additionalRoots] = roots;
    if (!primaryRoot || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const parts = [`!claude --resume ${quoteEzArgument(sessionId)}`];
    // `--add-dir` is variadic, so it takes every extra root at once and goes last.
    if (additionalRoots.length > 0) {
      parts.push('--add-dir', ...additionalRoots.map(quoteEzArgument));
    }
    return { commandText: parts.join(' '), displayCommandText: 'claude resume' };
  }

  buildNewCommand(roots: readonly string[], launch?: AgentPersonaLaunch): AgentResumeCommand | null {
    const [primaryRoot, ...additionalRoots] = roots;
    if (!primaryRoot || (launch && launch.provider !== 'claude')) return null;
    const parts = ['!claude'];
    if (launch?.provider === 'claude') {
      if (launch.model) parts.push('--model', quoteEzArgument(launch.model));
      if (launch.effort) parts.push('--effort', launch.effort);
      parts.push('--permission-mode', launch.permissionMode);
    }
    // Claude has no --cd. The caller creates the shell at primaryRoot, while
    // its variadic --add-dir receives every additional project root at once.
    if (additionalRoots.length > 0) {
      parts.push('--add-dir', ...additionalRoots.map(quoteEzArgument));
    }
    return { commandText: parts.join(' '), displayCommandText: 'claude' };
  }

  dispose(): Promise<void> {
    this.turnIndexes.clear();
    this.promptIndex = null;
    return Promise.resolve();
  }

  /** Directory entries and mtimes only — no transcript is opened here. */
  private async collectSessionFiles(roots: readonly string[]): Promise<readonly SessionFile[]> {
    let projectEntries: string[];
    try {
      projectEntries = await fs.readdir(this.projectsDirectory);
    } catch {
      return [];
    }
    const files: SessionFile[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      for (const name of claudeProjectDirNames(projectEntries, root)) {
        const directory = path.join(this.projectsDirectory, name);
        let sessionNames: string[];
        try {
          sessionNames = await fs.readdir(directory);
        } catch {
          continue;
        }
        for (const sessionName of sessionNames) {
          if (path.extname(sessionName) !== '.jsonl') continue;
          if (!SESSION_ID_PATTERN.test(path.basename(sessionName, '.jsonl'))) continue;
          const filePath = path.join(directory, sessionName);
          const key = process.platform === 'win32'
            ? filePath.toLocaleLowerCase('en-US')
            : filePath;
          if (seen.has(key)) continue;
          let stats;
          try {
            stats = await fs.stat(filePath);
          } catch {
            continue;
          }
          // Claude itself treats a zero-byte transcript as "no such session".
          if (!stats.isFile() || stats.size === 0) continue;
          seen.add(key);
          files.push({ filePath, root, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      }
    }
    files.sort((left, right) =>
      right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
    return files;
  }

  /**
   * Bounded head read for the session's own cwd, plus the shared prompt index
   * for its title. The first typed prompt is NOT reliably near the head — in a
   * real 10 MB transcript it sat 7.4 MB in, behind a session's worth of tool
   * traffic — so scanning for it here would mean reading whole transcripts just
   * to draw a list.
   */
  private async readSessionSummary(
    file: SessionFile,
    prompts: PromptIndex | null,
  ): Promise<ProviderHistorySession | null> {
    const length = Math.min(file.size, HEAD_SCAN_BYTES);
    let head: Buffer;
    try {
      head = await readRange(file.filePath, 0, length);
    } catch {
      return null;
    }
    const lines = head.toString('utf8').split('\n');
    // The final line is cut off unless the whole file fit in the window.
    if (file.size > head.length) lines.pop();

    let cwd = '';
    let createdAt = 0;
    let headPrompt = '';
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue;
      if (!cwd) {
        // The directory name is a lossy encoding, so the recorded cwd is what
        // distinguishes two roots that encode to the same directory.
        const recorded = asString(record.cwd);
        if (recorded && path.isAbsolute(recorded)) cwd = path.normalize(recorded);
      }
      if (!createdAt) createdAt = isoTimestamp(record.timestamp);
      if (!headPrompt && isHumanPrompt(record)) {
        headPrompt = messageText(asObject(record.message)?.content, 500).trim();
      }
      if (cwd && createdAt && headPrompt) break;
    }

    const indexed = prompts?.bySession.get(path.basename(file.filePath, '.jsonl'));
    const preview = indexed?.display ?? headPrompt;
    const resolvedCwd = cwd || path.normalize(file.root);
    return {
      privateId: file.filePath,
      parentPrivateId: null,
      title: preview.split(/\r?\n/u, 1)[0]?.trim().slice(0, 200) || 'Untitled session',
      preview,
      createdAt: createdAt || indexed?.createdAt || file.mtimeMs,
      updatedAt: file.mtimeMs,
      cwd: resolvedCwd,
      roots: [resolvedCwd],
      source: 'cli',
      rolloutPath: null,
    };
  }

  /**
   * `~/.claude/history.jsonl` is Claude's own prompt log: one line per typed
   * prompt, carrying `sessionId` and the text as entered. It is read ONLY to
   * look up sessions already found under a project root — never to enumerate
   * projects, which is exactly the global discovery this feature does not do.
   */
  private async readPromptIndex(): Promise<PromptIndex | null> {
    const filePath = path.join(this.claudeDirectory, 'history.jsonl');
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_PROMPT_INDEX_BYTES) return null;
    if (
      this.promptIndex
      && this.promptIndex.size === stats.size
      && this.promptIndex.mtimeMs === stats.mtimeMs
    ) {
      return this.promptIndex;
    }

    const bySession = new Map<string, PromptIndexEntry>();
    try {
      await streamLines(filePath, (line) => {
        const record = parseRecord(line);
        const session = asString(record?.sessionId);
        const display = asString(record?.display)?.trim();
        if (!record || !session || !display) return;
        // A leading `/` is a slash command. It counts as a title only while the
        // session has shown nothing else — real prose replaces it.
        const slash = display.startsWith('/');
        const current = bySession.get(session);
        if (current && (slash || !current.slashOnly)) return;
        const timestamp = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
          ? record.timestamp
          : 0;
        bySession.set(session, {
          display: display.slice(0, 500),
          createdAt: current?.createdAt ?? timestamp,
          slashOnly: slash,
        });
      });
    } catch {
      return null;
    }
    this.promptIndex = { bySession, size: stats.size, mtimeMs: stats.mtimeMs };
    return this.promptIndex;
  }

  private buildTurn(text: string, offset: number): AgentTranscriptTurn {
    const id = opaqueTranscriptId('turn', String(offset));
    const entries: AgentTranscriptEntry[] = [];
    text.split('\n').forEach((line, index) => {
      const record = parseRecord(line);
      if (record) entries.push(...transcriptEntries(record, id, index));
    });
    return { id, status: 'completed', entries };
  }

  private async turnIndex(filePath: string): Promise<TurnIndex | null> {
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!stats.isFile() || stats.size === 0) return null;
    const key = `${filePath}\0${String(stats.size)}\0${String(stats.mtimeMs)}`;
    const cached = this.turnIndexes.get(key);
    if (cached) return cached;

    const offsets: number[] = [];
    try {
      await streamLines(filePath, (line, offset) => {
        // Cheap gate first: a turn starts at a typed prompt, whose record always
        // serializes the literal `"human"`. Anything else skips the parse, which
        // matters when a single tool-result line is hundreds of KB.
        if (!line.includes('"human"')) return;
        const record = parseRecord(line);
        if (record && isHumanPrompt(record)) offsets.push(offset);
      });
    } catch {
      return null;
    }
    // A session made only of slash commands still renders as one turn.
    const index: TurnIndex = {
      offsets: offsets.length > 0 ? offsets : [0],
      size: stats.size,
    };
    this.turnIndexes.set(key, index);
    while (this.turnIndexes.size > MAX_INDEXED_TRANSCRIPTS) {
      const oldest = this.turnIndexes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.turnIndexes.delete(oldest);
    }
    return index;
  }
}
