import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  MAX_AGENT_HISTORY_PAGE_SIZE,
  MAX_AGENT_TRANSCRIPT_PAGE_SIZE,
  type AgentTranscriptEntry,
  type AgentTranscriptPage,
  type AgentTranscriptTurn,
} from '../shared/agent-history';
import { quoteEzArgument } from '../shared/quote-ez-argument';
import type {
  AgentHistoryProviderAdapter,
  AgentResumeCommand,
  ProviderHistorySession,
  ProviderHistorySessionPage,
  ProviderSessionQuery,
} from './agent-history-provider';
import type { CodexAppServerRequester } from './codex-app-server-client';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function boundedText(value: unknown, max = 20_000): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') parts.push(entry);
    else {
      const item = asObject(entry);
      const text = asString(item?.text) ?? asString(item?.content);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n').slice(0, max);
}

function opaqueTranscriptId(prefix: 'turn' | 'item', value: unknown, fallback: string): string {
  const source = asString(value) ?? fallback;
  return `${prefix}_${createHash('sha256').update(source).digest('hex').slice(0, 20)}`;
}

function optionalStatus(item: JsonObject): { readonly status?: string } {
  const status = asString(item.status)?.slice(0, 80);
  return status ? { status } : {};
}

function summarizeCommand(item: JsonObject): string {
  const command = asString(item.command) ?? asString(item.cmd) ?? '';
  return command.length > 500 ? `${command.slice(0, 497)}…` : command;
}

function transcriptEntry(
  value: unknown,
  index: number,
  namespace: string,
): AgentTranscriptEntry | null {
  const item = asObject(value);
  if (!item) return null;
  const type = asString(item.type) ?? '';
  const id = opaqueTranscriptId('item', item.id, `${namespace}:${index}`);
  switch (type) {
    case 'userMessage':
      return { type: 'message', id, role: 'user', markdown: boundedText(item.content) };
    case 'agentMessage':
      return { type: 'message', id, role: 'assistant', markdown: boundedText(item.text ?? item.content) };
    case 'commandExecution':
      return {
        type: 'activity',
        id,
        kind: 'command',
        summary: summarizeCommand(item) || 'Command',
        ...optionalStatus(item),
      };
    case 'fileChange':
      return {
        type: 'activity',
        id,
        kind: 'file-change',
        summary: boundedText(item.changes ?? item.description, 1_000) || 'File changes',
        ...optionalStatus(item),
      };
    case 'webSearch':
      return {
        type: 'activity',
        id,
        kind: 'web-search',
        summary: boundedText(item.query, 1_000) || 'Web search',
      };
    case 'plan':
      return {
        type: 'activity',
        id,
        kind: 'plan',
        summary: boundedText(item.text ?? item.plan, 2_000) || 'Plan updated',
      };
    case 'reasoning':
      return {
        type: 'activity',
        id,
        kind: 'reasoning',
        summary: boundedText(item.summary ?? item.text, 2_000) || 'Reasoning',
      };
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return {
        type: 'activity',
        id,
        kind: 'subagent',
        summary: boundedText(item.description ?? item.prompt, 1_000) || 'Subagent activity',
        ...optionalStatus(item),
      };
    case 'imageView':
    case 'imageGeneration':
      return { type: 'activity', id, kind: 'image', summary: type === 'imageView' ? 'Viewed image' : 'Generated image' };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return {
        type: 'activity',
        id,
        kind: 'tool',
        summary: boundedText(item.tool ?? item.name, 500) || 'Tool call',
        ...optionalStatus(item),
      };
    default:
      return null;
  }
}

function normalizeTurns(result: unknown, pageNamespace: string): readonly AgentTranscriptTurn[] {
  const object = asObject(result);
  const rawTurns = Array.isArray(object?.data)
    ? object.data
    : Array.isArray(object?.turns)
      ? object.turns
      : [];
  return rawTurns.flatMap((value, turnIndex): AgentTranscriptTurn[] => {
    const turn = asObject(value);
    if (!turn) return [];
    const id = opaqueTranscriptId('turn', turn.id, `${pageNamespace}:${turnIndex}`);
    const entries = (Array.isArray(turn.items) ? turn.items : [])
      .map((entry, entryIndex) => transcriptEntry(entry, entryIndex, id))
      .filter((entry): entry is AgentTranscriptEntry => entry !== null);
    return [{
      id,
      status: asString(turn.status)?.slice(0, 80) ?? 'completed',
      entries,
    }];
  });
}

function normalizeSource(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 80);
  const source = asObject(value);
  if (typeof source?.custom === 'string') return 'custom';
  if (asObject(source?.subAgent)) return 'subAgent';
  return asString(source?.type) ?? asString(source?.kind) ?? 'unknown';
}

export interface CodexHistoryAdapterOptions {
  /** @deprecated Rollout files are no longer read. Retained for API compatibility. */
  readonly codexHome?: string;
}

export class CodexHistoryAdapter implements AgentHistoryProviderAdapter {
  readonly provider = 'codex' as const;

  constructor(
    private readonly client: CodexAppServerRequester,
    _options: CodexHistoryAdapterOptions = {},
  ) {
    void _options;
  }

  async listSessions(query: ProviderSessionQuery): Promise<ProviderHistorySessionPage> {
    const limit = Math.max(1, Math.min(MAX_AGENT_HISTORY_PAGE_SIZE, Math.trunc(query.limit)));
    const result = asObject(await this.client.request('thread/list', {
      limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      archived: false,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      cwd: query.roots.length === 1 ? query.roots[0] : query.roots,
      useStateDbOnly: true,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    }));
    return {
      items: this.normalizeSessions(result),
      nextCursor: asString(result?.nextCursor),
    };
  }

  async readTranscript(privateId: string, cursor?: string, limit = 10): Promise<AgentTranscriptPage> {
    const boundedLimit = Math.max(1, Math.min(MAX_AGENT_TRANSCRIPT_PAGE_SIZE, Math.trunc(limit)));
    let result: unknown;
    let pagedTurns = true;
    try {
      result = await this.client.request('thread/turns/list', {
        threadId: privateId,
        limit: boundedLimit,
        sortDirection: 'desc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      });
    } catch {
      pagedTurns = false;
      result = await this.client.request('thread/read', {
        threadId: privateId,
        includeTurns: true,
      });
    }
    const object = asObject(result);
    const thread = asObject(object?.thread);
    const normalized = thread ? { turns: thread.turns } : result;
    return {
      historyId: '',
      provider: this.provider,
      turns: pagedTurns
        ? [...normalizeTurns(normalized, cursor ?? 'latest')].reverse()
        : normalizeTurns(normalized, 'full'),
      nextCursor: asString(object?.nextCursor),
    };
  }

  /** `!` selects a PTY in EZTerminal. The thread id stays main/interpreter
   * private; renderer frames and shell history receive only the display text. */
  buildResumeCommand(privateId: string, roots: readonly string[]): AgentResumeCommand | null {
    const [primaryRoot, ...additionalRoots] = roots;
    if (!primaryRoot) return null;
    return {
      commandText: [
        `!codex --cd ${quoteEzArgument(primaryRoot)}`,
        ...additionalRoots.map((root) => `--add-dir ${quoteEzArgument(root)}`),
        `resume ${quoteEzArgument(privateId)}`,
      ].join(' '),
      displayCommandText: 'codex resume',
    };
  }

  buildNewCommand(roots: readonly string[]): AgentResumeCommand | null {
    const [primaryRoot, ...additionalRoots] = roots;
    if (!primaryRoot) return null;
    return {
      commandText: [
        `!codex --cd ${quoteEzArgument(primaryRoot)}`,
        ...additionalRoots.map((root) => `--add-dir ${quoteEzArgument(root)}`),
      ].join(' '),
      displayCommandText: 'codex',
    };
  }

  dispose(): Promise<void> {
    return this.client.dispose();
  }

  private normalizeSessions(result: JsonObject | null): readonly ProviderHistorySession[] {
    const data = Array.isArray(result?.data) ? result.data : [];
    return data.flatMap((value): ProviderHistorySession[] => {
      const thread = asObject(value);
      if (!thread) return [];
      const privateId = asString(thread.id) ?? asString(thread.threadId);
      const cwd = asString(thread.cwd);
      if (!privateId || !cwd || !path.isAbsolute(cwd) || thread.ephemeral === true || asString(thread.parentThreadId)) {
        return [];
      }
      const normalizedCwd = path.normalize(cwd);
      const preview = boundedText(thread.preview, 500).trim();
      const explicitName = boundedText(thread.name, 200).trim();
      return [{
        privateId,
        parentPrivateId: null,
        title: explicitName || preview.split(/\r?\n/, 1)[0]?.trim() || 'Untitled session',
        preview,
        createdAt: timestamp(thread.createdAt),
        updatedAt: timestamp(thread.updatedAt),
        cwd: normalizedCwd,
        roots: [normalizedCwd],
        source: normalizeSource(thread.source),
        rolloutPath: null,
      }];
    });
  }
}
