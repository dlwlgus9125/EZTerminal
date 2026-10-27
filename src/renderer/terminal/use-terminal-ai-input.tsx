import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { BlockController } from '../block-controller';
import { readConversationViews } from '../conversation-views';
import { useAppTranslation } from '../i18n';
import { readSessionViewState, saveSessionViewState } from '../session-view-state';
import type { TerminalBlockEntry } from '../TerminalBlockEntries';
import { Menu, MenuItem } from '../ui';
import { excerptFromController, terminalOutputAttachment } from './block-excerpt';
import type { TerminalAiHost } from './terminal-ai-host';
import type { PendingTerminalAttachment } from './TerminalAiDock';
import {
  pickedConversationGone,
  resolveTerminalProjectId,
  resolveTerminalTarget,
  type TerminalProjectInputs,
  type TerminalTarget,
} from './terminal-target';

export type TerminalInputMode = 'shell' | 'ai';

/** Which draft an AI target writes to, as a key for the excerpts waiting to go there. */
export function targetKeyOf(target: TerminalTarget | null): string {
  if (target === null) return '';
  return target.kind === 'conversation' ? `conversation:${target.sessionId}` : `new:${target.projectId ?? ''}`;
}

export interface TerminalAiInputOptions {
  /** The app's conversations; null where the AI input is not offered. */
  readonly host: TerminalAiHost | null;
  /** Keys this terminal's input mode and its pick (a desktop pane's id, a phone tab's session). */
  readonly viewKey: string;
  /** The bound terminal session: blocks already offered are remembered per session. */
  readonly sessionId: string | null;
  /** What says which project this terminal is in, read when the target is resolved. */
  readonly projectInputs: () => TerminalProjectInputs;
  readonly blocks: () => readonly TerminalBlockEntry[];
  /** The terminal's own element: holds its AI input (focus) and names the document for the sent notice. */
  readonly root: () => HTMLElement | null;
  readonly focusShell: () => void;
}

/**
 * A terminal's prompt line types either a shell command or a message to a conversation: that
 * conversation's own message box, sharing its draft. Blocks attach as quoted chips. Shared by the
 * desktop terminal pane and the phone terminal (I3, I4).
 */
export function useTerminalAiInput(options: TerminalAiInputOptions) {
  const { t } = useAppTranslation();
  const { host: aiHost, viewKey, sessionId } = options;
  const latest = useRef(options);
  latest.current = options;
  const modeKey = `terminal-input-mode:${viewKey}`;
  const pickKey = `terminal-ai-target:${viewKey}`;
  const [inputMode, setInputMode] = useState<TerminalInputMode>('shell');
  const inputModeRef = useRef(inputMode);
  inputModeRef.current = inputMode;
  // Resolved when the AI input opens and kept while it stays open; a person's pick sticks to this terminal.
  const [aiTarget, setAiTarget] = useState<TerminalTarget | null>(null);
  const aiTargetKeyRef = useRef('');
  // Bumped whenever the person chooses where to send: the conversation a start box created only
  // becomes the destination if nothing was chosen since that box sent.
  const targetGenerationRef = useRef(0);
  const pickedRef = useRef<string | undefined>(readSessionViewState<string>(pickKey));
  // A conversation this terminal just started: kept as the pick until the snapshot lists it.
  const awaitingListingRef = useRef<string | null>(null);
  // Excerpts not yet in a draft, with the target they were attached for (they wait for it).
  const [pendingAttachments, setPendingAttachments] = useState<readonly (PendingTerminalAttachment & { readonly targetKey: string })[]>([]);
  // Blocks already put in a draft (or refused), per terminal session: the automatic attach never
  // offers them again, also after the pane is reopened.
  const offeredRunsRef = useRef(new Set<string>());
  const offeredKey = sessionId ? `terminal-ai-offered:${sessionId}` : null;
  useEffect(() => {
    offeredRunsRef.current = new Set(offeredKey ? readSessionViewState<string[]>(offeredKey) ?? [] : []);
  }, [offeredKey]);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const terminalProjectId = useCallback((): string | undefined => resolveTerminalProjectId(
    latest.current.projectInputs(),
    aiHost?.getSnapshot() ?? null,
  ), [aiHost]);

  /** The target now, or null while there is no snapshot to find "the last conversation" in. */
  const computeAiTarget = useCallback((): TerminalTarget | null => {
    const snapshot = aiHost?.getSnapshot() ?? null;
    const projectId = terminalProjectId();
    const picked = pickedRef.current;
    // A new conversation starts in the terminal's project, which takes a snapshot to know.
    if (picked === 'new') return !snapshot ? null : projectId ? { kind: 'new', projectId } : { kind: 'new' };
    if (picked && awaitingListingRef.current === picked && snapshot?.sessions.some((session) => session.id === picked)) {
      awaitingListingRef.current = null;
    }
    const awaiting = picked !== undefined && awaitingListingRef.current === picked;
    if (picked && pickedConversationGone(snapshot, picked, awaiting)) {
      pickedRef.current = undefined;
      saveSessionViewState<string | undefined>(pickKey, undefined);
    }
    if (!pickedRef.current && !snapshot) return null;
    return resolveTerminalTarget({
      snapshot,
      views: readConversationViews(),
      ...(projectId ? { projectId } : {}),
      ...(pickedRef.current ? { pickedSessionId: pickedRef.current, pickAwaitingListing: awaiting } : {}),
    });
  }, [aiHost, pickKey, terminalProjectId]);

  const setTarget = useCallback((target: TerminalTarget | null): void => {
    const key = targetKeyOf(target);
    aiTargetKeyRef.current = key;
    setAiTarget(target);
    // Excerpts attached before the target was known go to it; the others stay with their own target.
    if (target === null) return;
    const unresolved = targetKeyOf(null);
    setPendingAttachments((current) => (current.some((item) => item.targetKey === unresolved)
      ? current.map((item) => (item.targetKey === unresolved ? { ...item, targetKey: key } : item))
      : current));
  }, []);

  const focusAiInput = useCallback((): void => {
    requestAnimationFrame(() => latest.current.root()
      ?.querySelector<HTMLTextAreaElement>('.terminal-ai [data-testid="structured-agent-composer-input"]')?.focus());
  }, []);
  const focusShellInput = useCallback((): void => {
    requestAnimationFrame(() => latest.current.focusShell());
  }, []);

  /** `automatic`: the newest-block attach on entering the AI input, which leaves a block already waiting for its target alone. */
  const queueBlockAttachment = useCallback((entry: TerminalBlockEntry, automatic = false): void => {
    const controller = entry.controller;
    if (!controller) return;
    const attachment = terminalOutputAttachment(entry.id, controller.command, excerptFromController(controller), t('terminalAi.chipLabel'));
    const targetKey = aiTargetKeyRef.current;
    setPendingAttachments((current) => (automatic && current.some((item) => item.runId === entry.id)
      ? current
      : [...current.filter((item) => item.runId !== entry.id), { runId: entry.id, attachment, targetKey }]));
  }, [t]);

  /** Open the AI input; attach the given block, or else the newest finished one if it was not offered yet. */
  const enterAiInput = useCallback((block?: TerminalBlockEntry): void => {
    if (!aiHost) return;
    setTarget(computeAiTarget());
    if (block) {
      queueBlockAttachment(block);
    } else {
      const newest = [...latest.current.blocks()].reverse()
        .find((entry) => entry.controller && entry.controller.getSnapshot().status !== 'running');
      if (newest && !offeredRunsRef.current.has(newest.id)) queueBlockAttachment(newest, true);
    }
    setAiNotice(null);
    setInputMode('ai');
    saveSessionViewState<TerminalInputMode>(modeKey, 'ai');
    focusAiInput();
  }, [aiHost, computeAiTarget, focusAiInput, modeKey, queueBlockAttachment, setTarget]);

  const leaveAiInput = useCallback((): void => {
    setInputMode('shell');
    saveSessionViewState<TerminalInputMode>(modeKey, 'shell');
    focusShellInput();
  }, [focusShellInput, modeKey]);

  /** A block's "AI에게 보내기": into the open AI input's draft, or open it with that block. */
  const sendBlockToAi = useCallback((block: TerminalBlockEntry): void => {
    if (inputModeRef.current === 'ai') {
      queueBlockAttachment(block);
      focusAiInput();
      return;
    }
    enterAiInput(block);
  }, [enterAiInput, focusAiInput, queueBlockAttachment]);

  const pickAiTarget = useCallback((choice: string): void => {
    targetGenerationRef.current += 1;
    pickedRef.current = choice;
    saveSessionViewState<string>(pickKey, choice);
    setTarget(computeAiTarget());
    focusAiInput();
  }, [computeAiTarget, focusAiInput, pickKey, setTarget]);

  const settleAttachments = useCallback((applied: readonly string[], refused: readonly string[]): void => {
    for (const runId of [...applied, ...refused]) offeredRunsRef.current.add(runId);
    if (offeredKey) saveSessionViewState<string[]>(offeredKey, [...offeredRunsRef.current].slice(-200));
    setPendingAttachments((current) => current.filter((item) => !applied.includes(item.runId) && !refused.includes(item.runId)));
    if (refused.length > 0) setAiNotice(t('terminalAi.attachmentsFull'));
  }, [offeredKey, t]);

  const announceSent = useCallback((sentSessionId: string): void => {
    aiHost?.notifySent(sentSessionId, latest.current.root()?.ownerDocument ?? document);
  }, [aiHost]);

  /** A start box of this terminal created a conversation: it becomes the destination unless one was chosen since it sent. */
  const startedFromBox = useCallback((startGeneration: number, startedSessionId: string): void => {
    if (startGeneration === targetGenerationRef.current) {
      awaitingListingRef.current = startedSessionId;
      pickAiTarget(startedSessionId);
    }
    announceSent(startedSessionId);
  }, [announceSent, pickAiTarget]);

  // No snapshot yet when the AI input opened: resolve once the app has one.
  useEffect(() => {
    if (!aiHost || inputMode !== 'ai' || aiTarget !== null) return undefined;
    const resolve = (): void => {
      const target = computeAiTarget();
      if (target) setTarget(target);
    };
    resolve();
    return aiHost.subscribe(resolve);
  }, [aiHost, aiTarget, computeAiTarget, inputMode, setTarget]);

  // A terminal reopened in AI mode (tab moved, window changed) comes back to it once its session is bound.
  const modeRestoredRef = useRef(false);
  useEffect(() => {
    if (!aiHost || !sessionId || modeRestoredRef.current) return;
    modeRestoredRef.current = true;
    if (readSessionViewState<TerminalInputMode>(modeKey) !== 'ai') return;
    setTarget(computeAiTarget());
    setInputMode('ai');
  }, [aiHost, computeAiTarget, modeKey, sessionId, setTarget]);

  const blockMenu = useCallback((entry: TerminalBlockEntry & { readonly controller: BlockController }): ReactNode => (
    <Menu
      label={t('terminalAi.blockMenu')}
      placement="bottom-end"
      trigger={(
        <button type="button" className="btn block-menu" aria-label={t('terminalAi.blockMenu')} data-testid="block-menu">
          <span aria-hidden="true">⋯</span>
        </button>
      )}
    >
      <MenuItem onSelect={() => sendBlockToAi(entry)} data-testid="block-send-to-ai">{t('terminalAi.sendBlock')}</MenuItem>
    </Menu>
  ), [sendBlockToAi, t]);

  // The excerpts waiting for the target now shown.
  const aiPending = useMemo(() => pendingAttachments.filter((item) => item.targetKey === targetKeyOf(aiTarget)), [pendingAttachments, aiTarget]);

  return {
    inputMode,
    inputModeRef,
    aiTarget,
    aiPending,
    aiNotice,
    terminalProjectId,
    targetGenerationRef,
    enterAiInput,
    leaveAiInput,
    sendBlockToAi,
    pickAiTarget,
    settleAttachments,
    announceSent,
    startedFromBox,
    blockMenu,
  };
}
