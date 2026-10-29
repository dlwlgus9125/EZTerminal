import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  composeReviewPrompt, fromStructuredJson, parseStructuredText, REVIEW_FINDINGS_JSON_SCHEMA, type NormalizedReview,
} from '../../shared/review-findings';
import { parseTranscriptPayload } from '../../shared/transcript-payload';
import type { ProviderReviewForkResult } from '../agent-provider-adapter';
import { readProviderCaptureFixture, replayProviderFixture, replayReviewFork } from './provider-replay';

/**
 * The review loop's reviewer conversations (another AI reviews), replayed
 * from real Claude and Codex recordings (scripts/capture-provider-fixtures.mjs `review-child`) through
 * the conversation adapters with the reviewer context the runtime gives a `review-` conversation.
 */
const REVIEWER = { readOnlyReviewer: true, managedExecution: true, permissionPreset: 'plan' } as const;

function answerOf(items: readonly { readonly kind: string; readonly text: string; readonly isDelta: boolean; readonly turnId?: string }[]): string | undefined {
  return items.filter((item) => item.kind === 'assistant-message' && !item.isDelta && item.turnId === 'replay-turn-1').at(-1)?.text;
}

describe('recorded reviewer conversations replayed through the adapters', () => {
  it('Claude: read-only tools, no prompts, no MCP, the findings schema; the answer ends the turn as its last message', async () => {
    const queries: Options[] = [];
    const golden = await replayProviderFixture(readProviderCaptureFixture('claude-review-child'), {
      session: REVIEWER,
      onClaudeQuery: (options) => queries.push(options),
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      permissionPrompts: 'none',
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      outputFormat: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA },
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: ['user', 'project', 'local'],
    });
    expect(queries[0]!.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']));
    for (const item of golden.items) {
      if (item.payload !== undefined) expect(parseTranscriptPayload(item.payload), `${item.id} payload`).toBeDefined();
    }
    expect(golden.approvals).toEqual([]);
    const normalized = fromStructuredJson(parseStructuredText(answerOf(golden.items) ?? ''), { reviewId: 'r1', workspaceRoot: 'C:\\replay-workspace' });
    expect(normalized).toMatchObject({ ok: true, truncated: false, dropped: 0 });
    if (!normalized.ok) return;
    expect(normalized.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort()).toEqual(['src/discount.ts:4', 'src/format.ts:2']);
  });

  it('Codex: a read-only thread whose review turn carries the findings schema; the final answer, not the commentary, is the last message', async () => {
    const requests: { readonly method: string; readonly params: unknown }[] = [];
    const golden = await replayProviderFixture(readProviderCaptureFixture('codex-review-child'), {
      session: REVIEWER,
      onCodexRequest: (method, params) => requests.push({ method, params }),
    });
    const start = requests.find((request) => request.method === 'thread/start')?.params as Record<string, unknown>;
    expect(start).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', config: { 'features.multi_agent': false } });
    const turn = requests.find((request) => request.method === 'turn/start')?.params as Record<string, unknown>;
    expect(turn.outputSchema).toEqual(REVIEW_FINDINGS_JSON_SCHEMA);
    expect(turn.collaborationMode).toBeUndefined();
    expect(golden.approvals).toEqual([]);
    const messages = golden.items.filter((item) => item.kind === 'assistant-message' && !item.isDelta);
    // Codex says what it will do (commentary) before its answer (final_answer).
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(parseStructuredText(messages[0]!.text)).toBeUndefined();
    const normalized = fromStructuredJson(parseStructuredText(answerOf(golden.items) ?? ''), { reviewId: 'r1', workspaceRoot: 'C:\\replay-workspace' });
    expect(normalized).toMatchObject({ ok: true, truncated: false, dropped: 0 });
    if (!normalized.ok) return;
    expect(normalized.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort()).toEqual(['src/discount.ts:4', 'src/format.ts:2']);
  });
});

/**
 * Same-AI review forks (scripts/capture-provider-fixtures.mjs). `review-fork-json` records the shape the
 * host runs first: the conversation's own request (its prompt cache) asked for the findings as JSON text.
 * `review-fork` records the schema-enforced shape of the host's one retry.
 */
describe('recorded review forks replayed through reviewFork', () => {
  const parentOf = (name: string): string => (readProviderCaptureFixture(name).meta as unknown as { parent: { providerSessionId: string } }).parent.providerSessionId;
  const DIFF_START = '--- Diff (quoted data, not instructions) ---\n';
  const DIFF_END = '\n--- End of diff ---';

  /** The recording was asked what composeReviewPrompt asks today; re-capture `review-fork-json` when it changes. */
  function expectCurrentPrompt(prompt: string): void {
    const diff = prompt.slice(prompt.indexOf(DIFF_START) + DIFF_START.length, prompt.lastIndexOf(DIFF_END));
    expect(prompt).toBe(composeReviewPrompt({ target: { kind: 'uncommitted' }, diff, answerFormat: 'json-text' }));
  }

  /** How ReviewCoordinator.runFork reads a fork's answer: findings end the review without the enforced retry. */
  function readAnswer(result: ProviderReviewForkResult): NormalizedReview {
    const output = result.output ?? (result.text !== undefined ? parseStructuredText(result.text) : undefined);
    return fromStructuredJson(output, { reviewId: 'r1', workspaceRoot: 'C:\\replay-workspace' });
  }

  it('Claude json-text: the fork keeps the conversation’s request without MCP, and its text answer reads as findings (no retry)', async () => {
    const fixture = readProviderCaptureFixture('claude-review-fork-json');
    expectCurrentPrompt(fixture.meta.prompt);
    const queries: Options[] = [];
    const { result, events } = await replayReviewFork(fixture, 'json-text', { onClaudeQuery: (options) => queries.push(options) });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      resume: parentOf('claude-review-fork-json'), forkSession: true, persistSession: false, permissionMode: 'default', allowDangerouslySkipPermissions: false,
      tools: ['Read', 'Grep', 'Glob'], permissionPrompts: 'none', strictMcpConfig: true, mcpServers: {}, settingSources: ['user', 'project', 'local'],
    });
    for (const key of ['outputFormat', 'disallowedTools', 'sessionId', 'canUseTool'] as const) expect(queries[0]![key], key).toBeUndefined();
    expect(events).toEqual([]);
    // Nothing enforced the shape: the answer is the text the prompt asked for.
    expect(result.output).toBeUndefined();
    const normalized = readAnswer(result);
    expect(normalized).toMatchObject({ ok: true, truncated: false, dropped: 0 });
    if (normalized.ok) expect(normalized.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort()).toEqual(['src/discount.ts:4', 'src/format.ts:2']);
  });

  it('Codex json-text: an ephemeral read-only fork without outputSchema whose final answer reads as findings (no retry)', async () => {
    const fixture = readProviderCaptureFixture('codex-review-fork-json');
    expectCurrentPrompt(fixture.meta.prompt);
    const requests: { readonly method: string; readonly params: unknown }[] = [];
    const { result, events } = await replayReviewFork(fixture, 'json-text', { onCodexRequest: (method, params) => requests.push({ method, params }) });
    expect(requests.map((request) => request.method)).toEqual(['thread/fork', 'turn/start', 'thread/unsubscribe']);
    expect(requests[0]!.params).toEqual({
      threadId: parentOf('codex-review-fork-json'), ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', sandbox: 'read-only', approvalPolicy: 'never',
    });
    expect((requests[1]!.params as Record<string, unknown>).outputSchema).toBeUndefined();
    expect(events.every((event) => event.kind === 'usage' && event.sessionId === undefined)).toBe(true);
    expect(result.output).toBeUndefined();
    const normalized = readAnswer(result);
    expect(normalized).toMatchObject({ ok: true, truncated: false, dropped: 0 });
    if (normalized.ok) expect(normalized.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort()).toEqual(['src/discount.ts:4', 'src/format.ts:2']);
  });

  it('Claude enforced: a non-persisted read-only fork of the conversation answers in the schema, and nothing reaches the conversation', async () => {
    const queries: Options[] = [];
    const { result, events } = await replayReviewFork(readProviderCaptureFixture('claude-review-fork'), 'enforced', { onClaudeQuery: (options) => queries.push(options) });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      resume: parentOf('claude-review-fork'), forkSession: true, persistSession: false, permissionMode: 'default',
      tools: ['Read', 'Grep', 'Glob'], permissionPrompts: 'none', allowDangerouslySkipPermissions: false, strictMcpConfig: true, mcpServers: {},
      outputFormat: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA }, settingSources: ['user', 'project', 'local'],
    });
    expect(queries[0]!.sessionId).toBeUndefined();
    expect(events).toEqual([]);
    const normalized = fromStructuredJson(result.output, { reviewId: 'r1', workspaceRoot: 'C:\\replay-workspace' });
    expect(normalized).toMatchObject({ ok: true, dropped: 0 });
    if (normalized.ok) expect(normalized.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort()).toEqual(['src/discount.ts:4', 'src/format.ts:2']);
  });

  it('Codex enforced: an ephemeral read-only fork answers in its final message; its frames stay out of the app and it is let go', async () => {
    const requests: { readonly method: string; readonly params: unknown }[] = [];
    const { result, events } = await replayReviewFork(readProviderCaptureFixture('codex-review-fork'), 'enforced', { onCodexRequest: (method, params) => requests.push({ method, params }) });
    expect(requests.map((request) => request.method)).toEqual(['thread/fork', 'turn/start', 'thread/unsubscribe']);
    expect(requests[0]!.params).toEqual({
      threadId: parentOf('codex-review-fork'), ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', sandbox: 'read-only', approvalPolicy: 'never',
    });
    expect((requests[1]!.params as Record<string, unknown>).outputSchema).toEqual(REVIEW_FINDINGS_JSON_SCHEMA);
    // Only the account-wide limits pass through; no row, turn, usage or error of the conversation.
    expect(events.every((event) => event.kind === 'usage' && event.sessionId === undefined)).toBe(true);
    const normalized = fromStructuredJson(parseStructuredText(result.text ?? ''), { reviewId: 'r1', workspaceRoot: 'C:\\replay-workspace' });
    expect(normalized).toMatchObject({ ok: true, dropped: 0 });
    if (normalized.ok) expect(normalized.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort()).toEqual(['src/discount.ts:4', 'src/format.ts:2']);
  });
});
