import { createHash } from 'node:crypto';

import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import type { DaemonTranscriptItemInput } from './daemon-store';

/**
 * How a provider-native subagent lands in the daemon: its own session (keyed by
 * the adapter session it ran under and the provider's child id), a `link` row
 * in its parent, its parent's instruction as its first row, its own work, and
 * one bounded `result` row back in the parent. DaemonAgentRuntime and the
 * provider replay harness both build these rows here so they cannot drift.
 */

export const SUBAGENT_INSTRUCTION_LIMIT = 8_000;
export const SUBAGENT_RESULT_LIMIT = 2_000;

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function bounded(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Every subagent of a provider session, at any depth, is keyed by that session. */
export function nativeChildSessionId(providerId: string, rootSessionId: string, providerChildId: string): string {
  return stableId('native-agent', providerId, rootSessionId, providerChildId);
}

export interface NativeSubagentStart {
  readonly providerId: string;
  /** The adapter session the subagent ran under. */
  readonly rootSessionId: string;
  /** Where it nests: the root session, or the subagent that started it. */
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly providerChildId: string;
  readonly title: string;
  readonly toolUseId?: string;
  readonly subagentType?: string;
  readonly background?: boolean;
  readonly instruction?: string;
  /** The parent's live turn, so the link sits with the call that made it. */
  readonly parentTurnId?: string;
  readonly createdAt: string;
}

/** The parent's link to a new subagent, and the subagent's first row: what it was asked. */
export function subagentStartItems(start: NativeSubagentStart): DaemonTranscriptItemInput[] {
  const items: DaemonTranscriptItemInput[] = [{
    id: stableId('native-subagent-link', start.providerId, start.rootSessionId, start.providerChildId),
    sessionId: start.parentSessionId,
    ...(start.parentTurnId ? { turnId: start.parentTurnId } : {}),
    kind: 'notice',
    // Clients without the payload show this line with an Open button.
    text: `Subagent started: ${start.title}`,
    isDelta: false,
    isSensitive: false,
    relatedSessionId: start.childSessionId,
    payload: {
      v: 1,
      type: 'subagent',
      role: 'link',
      childSessionId: start.childSessionId,
      ...(start.toolUseId ? { callId: start.toolUseId } : {}),
      title: start.title.slice(0, 2_000),
      ...(start.subagentType ? { subagentType: start.subagentType.slice(0, 2_000) } : {}),
      ...(start.background !== undefined ? { background: start.background } : {}),
    },
    createdAt: start.createdAt,
  }];
  const instruction = start.instruction?.trim();
  if (instruction) {
    items.push({
      id: stableId('native-instruction', start.providerId, start.rootSessionId, start.providerChildId),
      sessionId: start.childSessionId,
      kind: 'user-message',
      text: bounded(instruction, SUBAGENT_INSTRUCTION_LIMIT),
      isDelta: false,
      isSensitive: true,
      payload: {
        v: 1,
        type: 'subagent',
        role: 'instruction',
        parentSessionId: start.parentSessionId,
        ...(start.toolUseId ? { callId: start.toolUseId } : {}),
      },
      createdAt: start.createdAt,
    });
  }
  return items;
}

export interface NativeSubagentResult {
  readonly providerId: string;
  readonly rootSessionId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly providerChildId: string;
  readonly toolUseId?: string;
  readonly state: 'done' | 'error';
  readonly summary: string;
  readonly parentTurnId?: string;
  readonly createdAt: string;
}

/** One bounded answer back in the parent; the subagent keeps the whole conversation. */
export function subagentResultItem(result: NativeSubagentResult): DaemonTranscriptItemInput | undefined {
  const summary = bounded(result.summary, SUBAGENT_RESULT_LIMIT);
  if (!summary) return undefined;
  return {
    id: stableId('native-parent-summary', result.providerId, result.rootSessionId, result.providerChildId, result.state),
    sessionId: result.parentSessionId,
    ...(result.parentTurnId ? { turnId: result.parentTurnId } : {}),
    kind: 'child-summary',
    text: summary,
    isDelta: false,
    isSensitive: true,
    relatedSessionId: result.childSessionId,
    payload: {
      v: 1,
      type: 'subagent',
      role: 'result',
      childSessionId: result.childSessionId,
      ...(result.toolUseId ? { callId: result.toolUseId } : {}),
      state: result.state,
    },
    createdAt: result.createdAt,
  };
}

/**
 * A row the provider produced inside a subagent, re-homed to the subagent's
 * session. Subagents have no turn records of their own: the parent's turn ids
 * would not belong to the child, and provider reconciliation must never treat
 * a projection as a turn it owns.
 */
export function routedChildItem(item: DaemonTranscriptItem, childSessionId: string): DaemonTranscriptItemInput {
  return {
    id: item.id,
    ...(item.messageId ? { messageId: item.messageId } : {}),
    sessionId: childSessionId,
    kind: item.kind,
    text: item.text,
    isDelta: item.isDelta,
    isSensitive: item.isSensitive,
    ...(item.relatedSessionId ? { relatedSessionId: item.relatedSessionId } : {}),
    ...(item.context ? { context: item.context } : {}),
    ...(item.payload ? { payload: item.payload } : {}),
    createdAt: item.createdAt,
  };
}
