import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { parseTranscriptPayload } from '../../shared/transcript-payload';
import {
  nextPromptText, PREDICT_INSTRUCTION, RECAP_INSTRUCTION, SUGGEST_TASK_CLAUDE_TOOL, SUGGEST_TASK_INSTRUCTIONS, SUGGEST_TASK_TOOL,
} from '../../shared/turn-wrap-up';
import type { AgentProviderEvent } from '../agent-provider-adapter';
import {
  PROVIDER_CAPTURE_DIRECTORY, readProviderCaptureFixture, replayProviderFixture, type JsonRpcFrame, type ProviderCaptureFixture,
} from './provider-replay';

/**
 * Real Claude and Codex recordings of turn wrap-up (scripts/capture-provider-fixtures.mjs): the facts the
 * host relies on, from the providers themselves. Re-capture when the shared instructions change.
 */
const RECORDINGS = ['claude-prompt-suggestion', 'claude-suggest-task', 'codex-suggest-task', 'codex-predict-fork', 'codex-recap-fork'] as const;

function sdkMessages(fixture: ProviderCaptureFixture): readonly SDKMessage[] {
  return fixture.lines.flatMap((line) => (line.dir === 'sdk' ? [line.msg] : []));
}

function outgoing(fixture: ProviderCaptureFixture, method: string): JsonRpcFrame | undefined {
  return fixture.lines.flatMap((line) => (line.dir === 'out' && line.frame.method === method ? [line.frame] : []))[0];
}

/** The items a Codex recording finished, in order. */
function codexItems(fixture: ProviderCaptureFixture): readonly Record<string, unknown>[] {
  return fixture.lines.flatMap((line) => (
    line.dir === 'in' && line.frame.method === 'item/completed' ? [(line.frame.params as { item: Record<string, unknown> }).item] : []
  ));
}

describe('turn wrap-up recordings', () => {
  it.each(RECORDINGS)('%s holds nothing of the account or this PC', (name) => {
    const text = readFileSync(path.join(PROVIDER_CAPTURE_DIRECTORY, `${name}.ndjson`), 'utf8');
    expect(text).not.toMatch(/[A-Za-z]:[\\/]+(?:Users|Working)\b/u);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/u);
  });

  it('Claude: the suggestion comes after the result, carries no turn id, and reads as one line', async () => {
    const fixture = readProviderCaptureFixture('claude-prompt-suggestion');
    expect(fixture.meta.launch).toMatchObject({ promptSuggestions: true });
    const messages = sdkMessages(fixture);
    const result = messages.findIndex((message) => message.type === 'result');
    const suggestion = messages.findIndex((message) => message.type === 'prompt_suggestion');
    expect(result).toBeGreaterThan(0);
    expect(suggestion).toBeGreaterThan(result);
    const message = messages[suggestion] as { readonly suggestion: string };
    expect(Object.keys(message).sort()).toEqual(['session_id', 'suggestion', 'type', 'uuid']);
    expect(nextPromptText(message.suggestion)).toBe(message.suggestion);

    const queries: Options[] = [];
    const events: AgentProviderEvent[] = [];
    await replayProviderFixture(fixture, {
      session: { wrapUp: { promptSuggestions: 'on' } }, onClaudeQuery: (options) => queries.push(options), onEvent: (event) => events.push(event),
    });
    expect(queries[0]).toMatchObject({ promptSuggestions: true });
    const finished = events.findIndex((event) => event.kind === 'turn-finished');
    const suggested = events.findIndex((event) => event.kind === 'prompt-suggestion');
    expect(suggested).toBeGreaterThan(finished);
    expect(events[suggested]).toEqual({ kind: 'prompt-suggestion', sessionId: 'replay-session', turnId: 'replay-turn-1', text: message.suggestion });
  });

  it('Claude: suggest_task runs by its exact allowed name without asking, and only the edit asks', async () => {
    const fixture = readProviderCaptureFixture('claude-suggest-task');
    expect(fixture.meta.launch).toMatchObject({ allowedTools: [SUGGEST_TASK_CLAUDE_TOOL] });
    const calls = sdkMessages(fixture).flatMap((message) => (message.type === 'assistant' ? message.message.content : []))
      .filter((block) => block.type === 'tool_use' && block.name === SUGGEST_TASK_CLAUDE_TOOL);
    expect(calls.length).toBeGreaterThan(0);
    expect(fixture.lines.flatMap((line) => (line.dir === 'canUseTool' ? [line.toolName] : []))).toEqual(['Edit']);
    const queries: Options[] = [];
    const golden = await replayProviderFixture(fixture, {
      session: { wrapUp: { suggestTask: true }, orchestration: { endpoint: 'http://127.0.0.1:4321/mcp/replay', bearerToken: 'replay-token' } },
      onClaudeQuery: (options) => queries.push(options),
    });
    expect(queries[0]!.allowedTools).toEqual([SUGGEST_TASK_CLAUDE_TOOL]);
    for (const item of golden.items) {
      if (item.payload !== undefined) expect(parseTranscriptPayload(item.payload), `${item.id} payload`).toBeDefined();
    }
    expect(golden.approvals).toHaveLength(1);
  });

  it('Codex: told at thread/start, it proposes through the tool in a read-only thread and changes nothing', async () => {
    const fixture = readProviderCaptureFixture('codex-suggest-task');
    expect(outgoing(fixture, 'thread/start')?.params).toMatchObject({ developerInstructions: SUGGEST_TASK_INSTRUCTIONS, approvalPolicy: 'never', sandbox: 'read-only' });
    const items = codexItems(fixture);
    expect(items.filter((item) => item.type === 'mcpToolCall' && item.tool === SUGGEST_TASK_TOOL).length).toBeGreaterThan(0);
    expect(items.filter((item) => item.type === 'fileChange' || item.type === 'commandExecution')).toEqual([]);
    // A tool marked read-only asks nothing.
    expect(fixture.lines.some((line) => line.dir === 'in' && line.frame.method === 'mcpServer/elicitation/request')).toBe(false);
    await expect(replayProviderFixture(fixture)).resolves.toBeDefined();
  });

  it('Codex: the next-message fork is asked what the host asks, at low effort, and answers one line', () => {
    const fixture = readProviderCaptureFixture('codex-predict-fork');
    expect(fixture.meta.prompt.endsWith(`\n\nQuestion: ${PREDICT_INSTRUCTION}`)).toBe(true);
    expect(outgoing(fixture, 'thread/fork')?.params).toMatchObject({ ephemeral: true, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'never' });
    expect(outgoing(fixture, 'turn/start')?.params).toMatchObject({ effort: 'low' });
    const answer = codexItems(fixture).filter((item) => item.type === 'agentMessage').at(-1);
    expect(nextPromptText(String(answer?.text))).toBeTruthy();
  });

  it('Codex: the recap fork is asked the shared instruction, at the conversation’s effort, and says only what happened', () => {
    const fixture = readProviderCaptureFixture('codex-recap-fork');
    expect(fixture.meta.prompt.endsWith(`\n\nQuestion: ${RECAP_INSTRUCTION}`)).toBe(true);
    expect((outgoing(fixture, 'turn/start')?.params as Record<string, unknown>).effort).toBeUndefined();
    const answer = String(codexItems(fixture).filter((item) => item.type === 'agentMessage').at(-1)?.text);
    expect(answer).toMatch(/src\/format\.ts/u);
    // The conversation changed nothing; the recap must not say it did.
    expect(answer).toMatch(/no tools|no files|not (?:changed|edited|run)|without/iu);
  });
});
