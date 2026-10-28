import { randomUUID } from 'node:crypto';

import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import { createDaemonCommand, type DaemonCommand, type DaemonCommandPayloads, type DaemonCommandReceipt, type DaemonEvent, type DaemonSnapshot } from '../shared/daemon-protocol';
import { childProgress, finalAssistantText, latestFinishedTurn, type TranscriptReader } from './managed-child-transcript';

/** Calls one conversation turn may make. */
export const ADVISOR_CALLS_PER_TURN = 2;
/** Calls one conversation may make (until the app restarts). */
export const ADVISOR_CALLS_PER_CONVERSATION = 6;
const ADVISOR_TIMEOUT_MS = 240_000;
const MAX_QUESTION_LENGTH = 20_000;
const MAX_ANSWER_LENGTH = 8_000;
const ADVISOR_PRINCIPAL = { kind: 'cli', id: 'advisor-runtime' } as const;
/** Advisor conversations are host-owned: read-only, no tools of ours, archived after they answer. */
export const ADVISOR_SESSION_PREFIX = 'advisor-';

export type AdvisorResult = { readonly ok: true; readonly answer: string; readonly truncated: boolean } | { readonly ok: false; readonly error: string };

export interface AgentAdvisorOptions {
  readonly enabled: () => boolean;
  /** 단계 연결's review agent, which the advisor runs as. */
  readonly reviewAgent: () => ChatAgentProfile | undefined;
  readonly getSnapshot: () => DaemonSnapshot;
  readonly execute: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  readonly readTranscript: TranscriptReader;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/**
 * 자문 (`ask_advisor`): one question to the review agent in its own read-only conversation (plan
 * permission, no orchestration, settings or workflow tools), which ends once it answers. Off until a
 * person turns it on; a few calls per turn and per conversation.
 */
export class AgentAdvisor {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly calls = new Map<string, number>();
  private readonly efforts = new Map<string, string | undefined>();

  constructor(private readonly options: AgentAdvisorOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /** An advisor conversation runs read-only with the review agent's effort, whatever its record says. */
  preparedSessionSettings(sessionId: string): { readonly permissionPreset: 'plan'; readonly reasoningEffort?: string } | undefined {
    if (!sessionId.startsWith(ADVISOR_SESSION_PREFIX)) return undefined;
    const effort = this.efforts.get(sessionId);
    return { permissionPreset: 'plan', ...(effort ? { reasoningEffort: effort } : {}) };
  }

  async ask(caller: { readonly sessionId: string; readonly turnId?: string; readonly workspaceId: string }, question: string, signal?: AbortSignal): Promise<AdvisorResult> {
    if (!this.options.enabled()) return { ok: false, error: '자문 (ask_advisor) is off. Only the person turns it on (Settings › AI); you may propose it with settings_propose {domain:"host", set:{advisor:true}}.' };
    const text = question.trim();
    if (!text || text.length > MAX_QUESTION_LENGTH) return { ok: false, error: `question must be 1-${String(MAX_QUESTION_LENGTH)} characters.` };
    const profile = this.options.reviewAgent();
    if (!profile) return { ok: false, error: 'No review agent is linked (Settings › AI › 단계 연결 › 검토). The advisor runs as that agent; ask the person to link one.' };
    const turnKey = `${caller.sessionId}\u0000${caller.turnId ?? ''}`;
    if ((this.calls.get(turnKey) ?? 0) >= ADVISOR_CALLS_PER_TURN) return { ok: false, error: `At most ${String(ADVISOR_CALLS_PER_TURN)} advisor questions per turn.` };
    if ((this.calls.get(caller.sessionId) ?? 0) >= ADVISOR_CALLS_PER_CONVERSATION) return { ok: false, error: `At most ${String(ADVISOR_CALLS_PER_CONVERSATION)} advisor questions per conversation.` };
    this.calls.set(turnKey, (this.calls.get(turnKey) ?? 0) + 1);
    this.calls.set(caller.sessionId, (this.calls.get(caller.sessionId) ?? 0) + 1);

    const sessionId = `${ADVISOR_SESSION_PREFIX}${this.createId()}`;
    this.efforts.set(sessionId, profile.reasoningEffort);
    const created = await this.command('agent.create', {
      sessionId,
      workspaceId: caller.workspaceId,
      title: `자문 · ${text.replace(/\s+/gu, ' ').slice(0, 60)}`,
      providerId: profile.providerId,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      permissionPreset: 'plan',
      initialPrompt: `You are an advisor another AI consults. Read what you need (you cannot change anything), answer the question directly and briefly, and stop.\n\n${text}`,
    });
    if (!created.ok) {
      this.efforts.delete(sessionId);
      return { ok: false, error: `The advisor could not start: ${created.error.message}` };
    }
    try {
      const finished = await this.waitUntilSettled(sessionId, signal);
      const snapshot = this.options.getSnapshot();
      const turn = latestFinishedTurn(snapshot.turns, sessionId);
      const answer = turn ? finalAssistantText(this.options.readTranscript, sessionId, turn.id)?.trim() : undefined;
      if (!finished) return { ok: false, error: 'The advisor did not answer in time.' };
      if (!answer) return { ok: false, error: 'The advisor finished without an answer.' };
      return { ok: true, answer: answer.slice(0, MAX_ANSWER_LENGTH), truncated: answer.length > MAX_ANSWER_LENGTH };
    } finally {
      await this.end(sessionId);
    }
  }

  private async waitUntilSettled(sessionId: string, signal?: AbortSignal, timeoutMs = this.options.timeoutMs ?? ADVISOR_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (settled: boolean): void => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(settled);
      };
      const check = (): void => {
        // It ends when it answers; an approval it asks for is not waited on (it is read-only anyway).
        if (childProgress(this.options.getSnapshot(), sessionId) !== 'working') finish(true);
      };
      const onAbort = (): void => finish(false);
      const unsubscribe = this.options.onEvent((event) => {
        if (event.kind === 'runtime.changed' || event.kind === 'entity.upserted' || event.kind === 'entity.archived') setImmediate(() => { if (!done) check(); });
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish(false);
      else check();
    });
  }

  /** Stops whatever is left and archives the advisor conversation (it stays readable in history). */
  private async end(sessionId: string): Promise<void> {
    const agent = this.options.getSnapshot().agents.find((entry) => entry.sessionId === sessionId);
    if (agent && (agent.currentTurnId || agent.queuedTurnCount > 0)) {
      await this.command('agent.cancel', { sessionId }).catch(() => undefined);
      await this.waitUntilSettled(sessionId, undefined, 10_000);
    }
    await this.command('agent.archive', { sessionId }).catch(() => undefined);
  }

  private async command<T extends 'agent.create' | 'agent.cancel' | 'agent.archive'>(type: T, payload: DaemonCommandPayloads[T]): Promise<DaemonCommandReceipt> {
    let receipt: DaemonCommandReceipt | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.createId();
      receipt = await this.options.execute(createDaemonCommand<T>({
        commandId: `advisor-command-${id}`,
        idempotencyKey: `advisor-${id}`,
        expectedRevision: this.options.getSnapshot().revision,
        issuedAt: this.now().toISOString(),
        principal: ADVISOR_PRINCIPAL,
        type,
        payload,
      }) as DaemonCommand);
      if (receipt.ok || receipt.error.code !== 'revision-conflict') return receipt;
    }
    return receipt!;
  }
}
