import type { AgentTranscriptEntry, AgentTranscriptPage } from '../../../shared/agent-history';
import type { DaemonTranscriptItem } from '../../../shared/daemon-protocol';
import { toolCategory } from '../../../shared/tool-catalog';
import type { ToolCategory, ToolPayload, ToolStatus } from '../../../shared/transcript-payload';

type Activity = Extract<AgentTranscriptEntry, { type: 'activity' }>;

const clip = (text: string): string => (text.length > 2_000 ? `${text.slice(0, 1_999)}…` : text);

function status(value: string | undefined): ToolStatus {
  switch (value) {
    case 'error':
    case 'failed':
      return 'failed';
    case 'declined':
    case 'denied':
      return 'denied';
    case 'interrupted':
    case 'cancelled':
      return 'interrupted';
    case 'inProgress':
    case 'running':
      return 'running';
    default:
      return 'completed';
  }
}

/** Claude history summarizes a tool call as "Name: detail" (or just "Name"). */
function claudeCall(summary: string): { readonly name: string; readonly detail?: string } {
  const match = summary.trim().match(/^([A-Za-z_][\w.-]*)(?::\s+([\s\S]+))?$/u);
  return match ? { name: match[1]!, ...(match[2] ? { detail: match[2] } : {}) } : { name: 'Tool', detail: summary };
}

/** Codex history keeps one finished entry per item; its kind decides the tool. */
function codexTool(entry: Activity): { readonly name: string; readonly category: ToolCategory } {
  switch (entry.kind) {
    case 'command': return { name: 'commandExecution', category: 'command' };
    case 'file-change': return { name: 'fileChange', category: 'edit' };
    case 'web-search': return { name: 'webSearch', category: 'web' };
    case 'subagent': return { name: 'subagent', category: 'agent' };
    case 'image': return { name: 'imageView', category: 'read' };
    default: return { name: 'tool', category: 'other' };
  }
}

/**
 * Provider history (Claude/Codex CLI sessions) as chat transcript items. Tool
 * activity becomes payload-carrying calls and results so the chat names each
 * tool and its target instead of showing anonymous results.
 */
export function historyTranscriptItems(page: AgentTranscriptPage | undefined, sessionId: string, createdAt: string): DaemonTranscriptItem[] {
  const items: DaemonTranscriptItem[] = [];
  const seen = new Set<string>();
  const push = (entry: AgentTranscriptEntry, turnId: string, item: Pick<DaemonTranscriptItem, 'kind' | 'text'> & { readonly payload?: ToolPayload }): void => {
    items.push({
      id: entry.id, messageId: entry.id, sessionId, turnId, sequence: items.length + 1,
      kind: item.kind, text: item.text, isDelta: false, isSensitive: false, createdAt,
      ...(item.payload ? { payload: item.payload } : {}),
    });
  };
  for (const turn of page?.turns ?? []) {
    // Claude results follow their calls in order; pair them here so each result keeps its tool.
    const openCalls: { readonly callId: string; readonly name: string; readonly category: ToolCategory }[] = [];
    for (const entry of turn.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.type === 'message') {
        push(entry, turn.id, { kind: entry.role === 'user' ? 'user-message' : 'assistant-message', text: entry.markdown });
        continue;
      }
      if (entry.kind === 'reasoning') {
        push(entry, turn.id, { kind: 'reasoning', text: entry.summary });
        continue;
      }
      if (entry.kind === 'plan') {
        push(entry, turn.id, { kind: 'notice', text: entry.summary });
        continue;
      }
      const files = entry.changedPaths?.slice(0, 200).map((path) => ({ path: clip(path) }));
      if (page?.provider === 'claude') {
        if (entry.status === undefined && entry.kind === 'tool' && entry.summary === 'Conversation compacted') {
          push(entry, turn.id, { kind: 'notice', text: entry.summary });
        } else if (entry.status === undefined) {
          const call = claudeCall(entry.summary);
          const category = toolCategory(call.name);
          openCalls.push({ callId: clip(entry.id), name: clip(call.name), category });
          push(entry, turn.id, {
            kind: 'tool-call', text: entry.summary,
            payload: {
              v: 1, type: 'tool', callId: clip(entry.id), name: clip(call.name), category, phase: 'call', status: 'running',
              ...(call.detail ? { target: clip(call.detail) } : {}),
              ...(call.detail && category === 'command' ? { command: call.detail.slice(0, 8_000) } : {}),
              ...(files?.length ? { files } : {}),
            },
          });
        } else {
          const call = openCalls.shift();
          push(entry, turn.id, {
            kind: 'tool-result', text: entry.summary,
            ...(call ? { payload: { v: 1, type: 'tool', callId: call.callId, name: call.name, category: call.category, phase: 'result', status: status(entry.status) } } : {}),
          });
        }
        continue;
      }
      const tool = codexTool(entry);
      push(entry, turn.id, {
        kind: 'tool-call', text: entry.summary,
        payload: {
          v: 1, type: 'tool', callId: clip(entry.id), name: tool.name, category: tool.category, phase: 'call', status: status(entry.status),
          target: clip(entry.summary.split('\n', 1)[0] ?? entry.summary),
          ...(tool.category === 'command' ? { command: entry.summary.slice(0, 8_000) } : {}),
          ...(files?.length ? { files } : {}),
        },
      });
    }
  }
  return items;
}
