import { X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import type { ChatAttachment } from '../../shared/chat-message';
import { MAX_CHAT_ATTACHMENTS } from '../../shared/chat-message';
import type { DaemonCommand } from '../../shared/daemon-protocol';
import type { CapabilityAccess } from '../capability-access';
import type { ChatRecoveryController, ChatRecoveryView, ChatStateAccess } from '../chat-recovery';
import { ConversationStartPanel } from '../ConversationStartPanel';
import { useConversationStartWiring } from '../conversation-start-wiring';
import { useAppTranslation } from '../i18n';
import { Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from '../ui';
import { useChatRecovery } from '../use-chat-recovery';
import { readConversationViews } from '../conversation-views';
import { isTerminalAttachment, looksSensitive } from './block-excerpt';
import { TerminalConversationComposer } from './TerminalConversationComposer';
import { terminalTargetCandidates, type TerminalTarget } from './terminal-target';
import { useTerminalAiSnapshot, type TerminalAiHost } from './terminal-ai-host';

/**
 * Where the AI input reads and writes when it is not the desktop renderer's: the phone's terminal (I4)
 * keeps drafts in its own encrypted store, reaches the PC over its connection and sends as itself.
 */
export interface TerminalAiWiring {
  readonly chatStateAccess: ChatStateAccess;
  readonly capabilities: CapabilityAccess;
  readonly principal: DaemonCommand['principal'];
  /** A new conversation's start box: daemon access, draft storage and capability client. */
  readonly start: ReturnType<typeof useConversationStartWiring>;
}

/** A block excerpt waiting to be put into the target's draft. */
export interface PendingTerminalAttachment {
  /** The run id it came from. */
  readonly runId: string;
  readonly attachment: ChatAttachment;
}

/** The start box of a terminal with no conversation to send to (one per project, shared by its terminals). */
export function terminalStartIdentity(projectId: string | undefined): string {
  return `terminal-start-${projectId ?? 'none'}`;
}

export interface TerminalAiDockProps {
  readonly host: TerminalAiHost;
  /** Where to send; a new conversation starts in the target's project. */
  readonly target: TerminalTarget;
  readonly pending: readonly PendingTerminalAttachment[];
  /** `applied` went into the draft; `refused` did not fit (the draft holds four attachments at most). */
  readonly onPendingSettled: (applied: readonly string[], refused: readonly string[]) => void;
  readonly onSent: (sessionId: string) => void;
  /** A new conversation started from this box: the terminal sends to it from now on. */
  readonly onStarted: (sessionId: string) => void;
  /** `/new` in the box: send to a new conversation instead. */
  readonly onNewConversation: () => void;
  /** The phone's terminal lays the box out as the phone does. */
  readonly variant?: 'desktop' | 'mobile';
  /** Omitted on the desktop (its renderer bridge); the phone passes its own. */
  readonly wiring?: TerminalAiWiring;
}

/** Put pending excerpts into a ready draft once; report what fit. */
function useApplyPending(
  controller: ChatRecoveryController | null,
  view: ChatRecoveryView,
  pending: readonly PendingTerminalAttachment[],
  onSettled: TerminalAiDockProps['onPendingSettled'],
): void {
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    // Only into a draft read back from storage: an edit while it loads would replace the stored draft.
    if (!controller || view.status !== 'ready' || pending.length === 0) return;
    const draft = controller.getSnapshot().draft;
    const attachments = [...(draft.attachments ?? [])];
    const applied: string[] = [];
    const refused: string[] = [];
    for (const item of pending) {
      if (attachments.some((existing) => existing.id === item.attachment.id)) { applied.push(item.runId); continue; }
      if (attachments.length >= MAX_CHAT_ATTACHMENTS) { refused.push(item.runId); continue; }
      attachments.push(item.attachment);
      applied.push(item.runId);
    }
    if (attachments.length !== (draft.attachments ?? []).length) controller.updateDraft({ ...draft, attachments });
    settled.current(applied, refused);
  }, [controller, pending, view.status]);
}

/** The excerpts in the draft, each readable before it is sent and removable. */
function TerminalChips({ controller, view }: { readonly controller: ChatRecoveryController | null; readonly view: ChatRecoveryView }): JSX.Element | null {
  const { t } = useAppTranslation();
  const chips = (view.draft.attachments ?? []).filter(isTerminalAttachment);
  if (!controller || chips.length === 0) return null;
  const sensitive = chips.some((chip) => looksSensitive(chip.data));
  const remove = (id: string): void => {
    const draft = controller.getSnapshot().draft;
    controller.updateDraft({ ...draft, attachments: (draft.attachments ?? []).filter((attachment) => attachment.id !== id) });
  };
  return (
    <div className="terminal-ai-chips" data-testid="terminal-ai-chips">
      <ul className="terminal-ai-chips__list">
        {chips.map((chip) => (
          <li key={chip.id} className="terminal-ai-chip" data-testid="terminal-ai-chip">
            <details>
              <summary>{chip.name}</summary>
              <pre className="terminal-ai-chip__preview" data-testid="terminal-ai-chip-preview">{chip.data}</pre>
            </details>
            <button type="button" className="terminal-ai-chip__remove" aria-label={t('terminalAi.removeChip', { name: chip.name })}
              onClick={() => remove(chip.id)} data-testid="terminal-ai-chip-remove">
              <X aria-hidden="true" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <p className="terminal-ai-chips__warning" data-sensitive={sensitive || undefined} role={sensitive ? 'alert' : undefined}>
        {sensitive ? t('terminalAi.chipSensitive') : t('terminalAi.chipWarning')}
      </p>
    </div>
  );
}

function ConversationTarget({ host, sessionId, pending, onPendingSettled, onSent, onNewConversation, variant, wiring }: {
  readonly variant: 'desktop' | 'mobile';
  readonly wiring?: TerminalAiWiring;
  readonly host: TerminalAiHost;
  readonly sessionId: string;
  readonly pending: readonly PendingTerminalAttachment[];
  readonly onPendingSettled: TerminalAiDockProps['onPendingSettled'];
  readonly onSent: (sessionId: string) => void;
  readonly onNewConversation: () => void;
}): JSX.Element {
  const snapshot = useTerminalAiSnapshot(host);
  const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  // The same shared controller as the conversation's tab and the box below.
  const recovery = useChatRecovery(session?.projectId, session ? sessionId : null, wiring?.chatStateAccess);
  useApplyPending(recovery.controller, recovery.view, pending, onPendingSettled);
  return (
    <>
      <TerminalChips controller={recovery.controller} view={recovery.view} />
      <TerminalConversationComposer sessionId={sessionId} snapshot={snapshot} onSent={onSent} onNewConversation={onNewConversation} variant={variant}
        {...(wiring ? { capabilities: wiring.capabilities, chatStateAccess: wiring.chatStateAccess, principal: wiring.principal } : {})} />
    </>
  );
}

function NewConversationTarget({ host, projectId, pending, onPendingSettled, onStarted, variant, wiring }: {
  readonly variant: 'desktop' | 'mobile';
  readonly wiring?: TerminalAiWiring;
  readonly host: TerminalAiHost;
  readonly projectId?: string;
  readonly pending: readonly PendingTerminalAttachment[];
  readonly onPendingSettled: TerminalAiDockProps['onPendingSettled'];
  readonly onStarted: (sessionId: string) => void;
}): JSX.Element {
  const snapshot = useTerminalAiSnapshot(host);
  const desktopStart = useConversationStartWiring(snapshot, projectId);
  const start = wiring?.start ?? desktopStart;
  const identity = terminalStartIdentity(projectId);
  // The start box's own draft (same scope as ConversationStartPanel uses), so chips land in its first message.
  const recovery = useChatRecovery(projectId ?? 'drafts', identity, start.storage, 'draft');
  useApplyPending(recovery.controller, recovery.view, pending, onPendingSettled);
  return (
    <>
      <TerminalChips controller={recovery.controller} view={recovery.view} />
      <ConversationStartPanel
        identity={identity}
        presentation="composer"
        variant={variant}
        {...(projectId ? { projectId } : {})}
        snapshot={snapshot}
        access={start.access}
        storage={start.storage}
        capabilityClient={start.capabilityClient}
        {...(start.workspaceFolders ? { workspaceFolders: start.workspaceFolders } : {})}
        onStarted={(sessionId) => onStarted(sessionId)}
      />
    </>
  );
}

/**
 * A terminal's AI input: the chosen conversation's real message box (or a new
 * conversation's start box), with the terminal output attached to its draft as
 * chips the person can read and remove before sending.
 */
export function TerminalAiDock({ host, target, pending, onPendingSettled, onSent, onStarted, onNewConversation, variant = 'desktop', wiring }: TerminalAiDockProps): JSX.Element {
  return (
    <div className="terminal-ai" data-testid="terminal-ai" data-target={target.kind}>
      {target.kind === 'conversation' ? (
        <ConversationTarget key={target.sessionId} variant={variant} {...(wiring ? { wiring } : {})} host={host} sessionId={target.sessionId} pending={pending}
          onPendingSettled={onPendingSettled} onSent={onSent} onNewConversation={onNewConversation} />
      ) : (
        // The project the target was resolved in, so the start box keeps its draft while the dock is hidden.
        <NewConversationTarget key={target.projectId ?? 'none'} variant={variant} {...(wiring ? { wiring } : {})} host={host} {...(target.projectId ? { projectId: target.projectId } : {})}
          pending={pending} onPendingSettled={onPendingSettled} onStarted={onStarted} />
      )}
    </div>
  );
}

/** "보낼 곳: name ▾": the target and the menu to send elsewhere in this terminal's project. */
export function TerminalTargetPicker({ host, target, projectId, onPick }: {
  readonly host: TerminalAiHost;
  readonly target: TerminalTarget;
  readonly projectId?: string;
  readonly onPick: (sessionId: string | 'new') => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const snapshot = useTerminalAiSnapshot(host);
  const candidates = useMemo(() => terminalTargetCandidates(snapshot, readConversationViews(), projectId), [projectId, snapshot]);
  const name = target.kind === 'conversation'
    ? snapshot?.sessions.find((session) => session.id === target.sessionId)?.title ?? target.title
    : t('terminalAi.newConversation');
  return (
    <Menu
      label={t('terminalAi.targetMenu')}
      placement="top-start"
      className="terminal-ai-target-menu"
      trigger={(
        <button type="button" className="terminal-ai-target" data-testid="terminal-ai-target" aria-haspopup="menu">
          {t('terminalAi.sendTo')} <b>{name}</b> <span aria-hidden="true">▾</span>
        </button>
      )}
    >
      <MenuLabel>{t('terminalAi.targetMenu')}</MenuLabel>
      {candidates.map((candidate) => (
        <MenuRadioItem key={candidate.sessionId} checked={target.kind === 'conversation' && target.sessionId === candidate.sessionId}
          onSelect={() => onPick(candidate.sessionId)} data-testid="terminal-ai-target-option">
          {candidate.title}
        </MenuRadioItem>
      ))}
      {candidates.length > 0 && <MenuSeparator />}
      <MenuItem onSelect={() => onPick('new')} data-testid="terminal-ai-target-new">{t('terminalAi.newConversation')}</MenuItem>
    </Menu>
  );
}
