import type { ChatMessageContext } from '../shared/chat-message';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { LONG_RUN_CAPABILITY, type LimitAction, type SteeredMessage } from '../shared/long-run';
import type { ChatLongRunAction } from './chat/ChatContext';
import { chatCopy } from './chat/copy';
import { limitHeader } from './chat/long-run/long-run-presentation';
import type { ChatLocale } from './chat/model/summary';
import type { ConversationCommandAccess } from './conversation-commands';
import type { StructuredAgentSessionPanelProps, StructuredAgentUiResult } from './StructuredAgentSession';
import { sendCardCommand, uiResult } from './turn-wrap-up-commands';

/**
 * Long-run continuity as the conversation screens use it (`long-run-v1`), shared by the desktop tab and the phone: the
 * message box while a turn runs, the tray, the limit card's buttons, and what the header says of a limit. How a message
 * is sent stays with each screen: its escrow is theirs.
 */

const ACTIONS: Readonly<Record<ChatLongRunAction['kind'], LimitAction>> = {
  'limit-try-now': 'try-now', 'limit-resume': 'resume', 'limit-auto-off': 'auto-off', 'limit-auto-on': 'auto-on',
  'limit-schedule': 'schedule', 'limit-unschedule': 'unschedule', 'limit-leave': 'leave',
};

const NO_STEERS: readonly SteeredMessage[] = [];

export interface LongRunHostInput {
  readonly snapshot: DaemonSnapshot | null;
  readonly sessionId: string;
  readonly access: ConversationCommandAccess;
  readonly locale: ChatLocale;
  /** Plain text, into the turn the host says is running. */
  readonly onSteer: (turnId: string, prompt: string) => Promise<StructuredAgentUiResult>;
  /** What cannot go in: it waits in the queue, whose row says why. */
  readonly onQueue: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
}

export interface LongRunHostProps {
  readonly longRun: NonNullable<StructuredAgentSessionPanelProps['longRun']>;
  readonly statusLabel?: string;
}

/** Nothing on a host without `long-run-v1`, and on an AI below its measured version the box stays as it is. */
export function longRunHost({ snapshot, sessionId, access, locale, onSteer, onQueue }: LongRunHostInput): LongRunHostProps | undefined {
  if (!snapshot?.capabilities?.includes(LONG_RUN_CAPABILITY)) return undefined;
  const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
  const turnId = agent?.currentTurnId;
  const open = snapshot.usageLimits?.[sessionId];
  // A running turn speaks for itself, unless it is the send the card is waiting on.
  const speaks = open !== undefined && (turnId === undefined || open.phase === 'resuming');
  const { statusLabel, ...header } = speaks ? limitHeader(open, chatCopy(locale).longRun.limit, locale) : { statusLabel: undefined };
  const settle = async (message: SteeredMessage, action: 'queue' | 'box'): Promise<StructuredAgentUiResult> => (
    uiResult(await sendCardCommand(access, 'agent.steer-settle', { sessionId, steerId: message.id, action }))
  );
  const steers = agent !== undefined && snapshot.longRunSupport?.[agent.providerId] === true;
  return {
    ...(statusLabel ? { statusLabel } : {}),
    longRun: {
      ...(open ? { openLimit: open } : {}),
      ...header,
      onAction: async ({ kind, stopId }) => uiResult(await sendCardCommand(access, 'long-run.limit-action', { sessionId, stopId, action: ACTIONS[kind] })),
      ...(steers ? {
        steer: {
          messages: snapshot.steers?.[sessionId] ?? NO_STEERS,
          ...(turnId === undefined ? { noTurn: true as const } : {}),
          onSteer: (prompt: string) => onSteer(turnId!, prompt),
          onQueue,
          onToQueue: (message: SteeredMessage) => settle(message, 'queue'),
          onToBox: (message: SteeredMessage) => settle(message, 'box'),
        },
      } : {}),
    },
  };
}
