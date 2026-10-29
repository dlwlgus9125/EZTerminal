import {
  createDaemonCommand,
  REVIEWER_SESSION_PREFIX,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonReviewer,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
} from '../shared/daemon-protocol';
import { isReviewFailureReason, REVIEW_LOOP_CAPABILITY } from '../shared/review-findings';
import { parseTranscriptPayload, type ReviewPayload } from '../shared/transcript-payload';
import type { ChatReviewAction } from './chat/ChatContext';
import { chatCopy } from './chat/copy';
import type { ChatLocale } from './chat/model/summary';
import { providerName } from './chat/review/review-presentation';
import type { ReviewerChoice, ReviewStartOptions, ReviewStartRequest } from './chat/review/ReviewStartMenu';
import { opaqueId, type ConversationCommandAccess } from './conversation-commands';
import type { StructuredAgentUiResult } from './StructuredAgentSession';

/**
 * The review loop's host side as the conversation screens use it (`review-loop-v1`), shared by the
 * desktop tab and the phone: what the start form offers from the host's snapshot, and the
 * `review.*` commands behind the form and the card's buttons.
 */

/** The latest row of a review card in the transcript: who reviewed, what it read and what it found. */
export function latestReviewPayload(items: readonly DaemonTranscriptItem[], reviewId: string): ReviewPayload | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const raw = items[index]!.payload;
    if (!raw) continue;
    const payload = parseTranscriptPayload(raw);
    if (payload?.type === 'review' && payload.reviewId === reviewId) return payload;
  }
  return undefined;
}

type ReviewCommandType = 'review.start' | 'review.fix' | 'review.resolve' | 'review.cancel';

/** The host's answer; `fits`: a fix batch over the message budget, and how many of its findings would fit. */
export type ReviewCommandResult = { readonly ok: true } | { readonly ok: false; readonly message: string; readonly fits?: number };

const PRINCIPAL = { kind: 'desktop', id: 'renderer-agent-ui' } as const;

/**
 * One `review.*` command against the latest snapshot. A revision race is read again once, as handing a
 * conversation off does; the payload (and so the review id) stays the same, so a retry never makes a
 * second card. No answer is reported as such, never retried.
 */
export async function runReviewCommand<T extends ReviewCommandType>(
  access: ConversationCommandAccess,
  type: T,
  payload: DaemonCommandPayloads[T],
): Promise<ReviewCommandResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authority = await access.latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const commandId = opaqueId('command');
    const command = createDaemonCommand<T>({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: access.principal ?? PRINCIPAL,
      type,
      payload,
    });
    const receipt = await access.sendCommand(command as DaemonCommand);
    if (!receipt) return { ok: false, message: 'The Agent daemon did not answer. Check the card before trying again.' };
    if (receipt.ok) return { ok: true };
    if (receipt.error.code !== 'revision-conflict') {
      const fits = receipt.error.details?.fits;
      return { ok: false, message: receipt.error.message, ...(typeof fits === 'number' ? { fits } : {}) };
    }
  }
  return { ok: false, message: 'The conversation changed meanwhile. Try again.' };
}

/** What the host needs from the screen to offer reviews of one conversation. */
export interface ReviewHostInput {
  readonly snapshot: DaemonSnapshot | null;
  readonly sessionId: string;
  readonly items: readonly DaemonTranscriptItem[];
  readonly access: ConversationCommandAccess;
  readonly locale: ChatLocale;
  /** Desktop: the worktree's base branch by name. Without it a worktree still offers its base; the host finds it. */
  readonly baseRef?: string;
  /** 단계 연결 (desktop): the review agent another AI reviews as, when that agent is that AI. */
  readonly reviewAgent?: (providerId: string) => { readonly name: string; readonly model?: string; readonly reasoningEffort?: string } | undefined;
  readonly modelLabel?: (providerId: string, model: string) => string;
  /** Opens another conversation: the reviewer's, from a card. */
  readonly openSession?: (sessionId: string) => void;
}

export interface ReviewHostProps {
  readonly reviewStart: {
    readonly options: ReviewStartOptions;
    readonly onStart: (request: ReviewStartRequest) => Promise<StructuredAgentUiResult>;
  };
  readonly onReviewAction: (action: ChatReviewAction) => Promise<StructuredAgentUiResult>;
}

const EFFORT: Readonly<Record<ChatLocale, Readonly<Record<string, string>>>> = {
  en: { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' },
  ko: { minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' },
};

/**
 * The start form's choices and the card's commands for one conversation, or nothing on a host without
 * `review-loop-v1` (the screen keeps its older 검토 맡기기). The model and effort shown for each reviewer
 * are what the host picks when the command names none (D8): this AI's conversation settings, another AI's
 * 단계 연결 review agent when it is that AI, else its defaults.
 */
export function reviewHost(input: ReviewHostInput): ReviewHostProps | undefined {
  const { snapshot, sessionId, access } = input;
  if (!snapshot?.capabilities?.includes(REVIEW_LOOP_CAPABILITY) || sessionId.startsWith(REVIEWER_SESSION_PREFIX)) return undefined;
  const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
  const session = snapshot.sessions.find((entry) => entry.id === sessionId);
  if (!agent || !session) return undefined;
  const copy = chatCopy(input.locale).aiReview;
  const support = snapshot.reviewSupport ?? {};
  const label = (providerId: string, model: string): string => input.modelLabel?.(providerId, model) ?? model;
  const effort = (value: string): string => EFFORT[input.locale][value] ?? value;
  const settings = (providerId: string, model?: string, reasoningEffort?: string): string | undefined => {
    const parts = [...(model ? [label(providerId, model)] : []), ...(reasoningEffort ? [effort(reasoningEffort)] : [])];
    return parts.length ? parts.join(' · ') : undefined;
  };
  const why = (providerId: string): string => {
    const reason = support[providerId]?.reason ?? 'provider-unavailable';
    return isReviewFailureReason(reason) ? copy.reason[reason](providerName(providerId)) : reason;
  };

  const selfText = settings(agent.providerId, agent.model, agent.reasoningEffort);
  // D13 as the host runs it: this AI's fork waits for a running turn and for queued ones (they would change files
  // during the review); another AI waits only for the turn running when it starts.
  const running = agent.currentTurnId !== undefined;
  const self: ReviewerChoice = {
    waits: running || agent.queuedTurnCount > 0,
    providerId: agent.providerId,
    ...(support[agent.providerId]?.self !== true ? { unavailableReason: why(agent.providerId) }
      // A fork needs the provider's conversation: nothing to fork before the first message.
      : !agent.providerSessionId ? { unavailableReason: copy.start.selfNotStarted } : {}),
    ...(selfText ? { settingsText: selfText } : {}),
  };
  const others = snapshot.providers
    .filter((provider) => provider.id !== agent.providerId && support[provider.id] !== undefined)
    .map((provider): ReviewerChoice => {
      const linked = input.reviewAgent?.(provider.id);
      const settingsText = linked
        ? [copy.start.reviewAgent(linked.name), settings(provider.id, linked.model, linked.reasoningEffort)].filter(Boolean).join(' · ')
        // Without 단계 연결 to read (the phone), nothing is claimed.
        : input.reviewAgent ? copy.start.defaultSettings : undefined;
      return {
        providerId: provider.id,
        waits: running,
        ...(support[provider.id]?.reviewer !== true ? { unavailableReason: why(provider.id) } : {}),
        ...(settingsText ? { settingsText } : {}),
      };
    });
  const workspace = snapshot.workspaces.find((entry) => entry.id === session.workspaceId);
  const options: ReviewStartOptions = {
    self,
    others,
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(workspace?.kind === 'worktree' ? { worktree: true } : {}),
  };
  const answer = (result: ReviewCommandResult): StructuredAgentUiResult => (result.ok ? { ok: true }
    : { ok: false, message: result.fits !== undefined ? copy.fixTooLong(result.fits) : result.message });

  const start = async (reviewer: DaemonReviewer, target: DaemonCommandPayloads['review.start']['target'], focus?: string): Promise<StructuredAgentUiResult> => answer(
    await runReviewCommand(access, 'review.start', { sessionId, reviewId: opaqueId('rv'), reviewer, target, ...(focus ? { focus } : {}) }),
  );
  /** Another AI reviews in a read-only conversation of its own; its id is new for every review and marks it a reviewer's. */
  const otherReviewer = (providerId: string): DaemonReviewer => ({ kind: 'other', providerId, reviewerSessionId: `${REVIEWER_SESSION_PREFIX}${opaqueId('s')}` });

  return {
    reviewStart: {
      options,
      onStart: (request) => start(request.reviewer.mode === 'self' ? { kind: 'self' } : otherReviewer(request.reviewer.providerId), request.target, request.focus),
    },
    onReviewAction: async (action) => {
      const findingIds = action.findingIds ?? [];
      switch (action.kind) {
        case 'fix':
        case 'fix-all':
          return findingIds.length ? answer(await runReviewCommand(access, 'review.fix', { sessionId, reviewId: action.reviewId, findingIds })) : { ok: true };
        case 'dismiss':
        case 'reopen':
          return findingIds.length
            ? answer(await runReviewCommand(access, 'review.resolve', { sessionId, reviewId: action.reviewId, findingIds, state: action.kind === 'dismiss' ? 'dismissed' : 'open' }))
            : { ok: true };
        case 'cancel':
          return answer(await runReviewCommand(access, 'review.cancel', { sessionId, reviewId: action.reviewId }));
        case 'retry': {
          // 다시 검토: a new card with the same reviewer, scope and focus.
          const card = latestReviewPayload(input.items, action.reviewId);
          if (!card) return { ok: false, message: copy.cardGone };
          return start(card.reviewer.mode === 'self' ? { kind: 'self' } : otherReviewer(card.reviewer.providerId), card.target, card.focus);
        }
        case 'open-reviewer': {
          const reviewerSession = latestReviewPayload(input.items, action.reviewId)?.reviewer.sessionId;
          if (reviewerSession && input.openSession) input.openSession(reviewerSession);
          return { ok: true };
        }
        default:
          return { ok: true };
      }
    },
  };
}
