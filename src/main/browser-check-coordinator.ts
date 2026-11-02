import { randomUUID } from 'node:crypto';

import { BROWSER_CHECK_PRINCIPAL, BROWSER_CHECK_PROMPT, type BrowserViewState } from '../shared/browser';
import { conversationFileChanges } from '../shared/conversation-changes';
import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonSnapshot, type DaemonTranscriptItem, type DaemonTurn } from '../shared/daemon-protocol';
import { latestFinishedTurn, type TranscriptReader } from './managed-child-transcript';
import { conversationBusy, readPages } from './review-coordinator';
import { turnWrapUpPauses, wrapUpAllowed } from './turn-wrap-up-coordinator';

/**
 * The one automatic screen check (`AUTOMATIC_CALLS['browser-check']`): after a turn a person sent that changed files, while
 * the pane shows a local or file page, one more turn in the same conversation. It is the host's own turn, and only a person's
 * turn earns one, so it never chains. Off by default, and it stands down near a usage limit. Nothing navigates: the AI looks
 * at what the pane shows, and the card says from the host's log whether it did.
 */

const SEND_TRIES = 3;
/** Finished turns already looked at. A turn is reported more than once; a restart reports none again. */
const REMEMBERED_TURNS = 200;

export interface BrowserCheckDeps {
  /** The switch, read at each turn's end. */
  readonly autoCheck: () => boolean;
  /** This conversation's AI was launched with the browser tools. */
  readonly listed: (sessionId: string) => boolean;
  readonly pane: (sessionId: string) => BrowserViewState | undefined;
  readonly getSnapshot: () => DaemonSnapshot;
  /** A host-prepared conversation (a review, an advisor) gets none of this. */
  readonly prepared: (sessionId: string) => boolean;
  /** The command that queued a turn. Null when it cannot be told. */
  readonly turnCommand: (turn: DaemonTurn) => DaemonCommand | null;
  readonly readTranscript: TranscriptReader;
  readonly execute: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

function originOf(url: string): string {
  const { origin } = new URL(url);
  return origin === 'null' ? url : origin;
}

export class BrowserCheckCoordinator {
  private readonly seen = new Set<string>();

  constructor(private readonly deps: BrowserCheckDeps) {}

  async turnFinished(turn: DaemonTurn): Promise<void> {
    if (turn.state !== 'completed' || this.seen.has(turn.id) || !this.deps.autoCheck()) return;
    this.seen.add(turn.id);
    if (this.seen.size > REMEMBERED_TURNS) this.seen.delete(this.seen.values().next().value!);
    const target = this.target(turn);
    if (target) await this.send(turn, target);
  }

  private personSent(snapshot: DaemonSnapshot, turn: DaemonTurn): boolean {
    const command = this.deps.turnCommand(turn);
    if (command?.principal.kind !== 'desktop' && command?.principal.kind !== 'android') return false;
    return wrapUpAllowed(snapshot, turn.sessionId, { prepared: this.deps.prepared(turn.sessionId), turnCommand: command });
  }

  private changedFiles(turn: DaemonTurn): boolean {
    const items: DaemonTranscriptItem[] = [];
    readPages(this.deps.readTranscript, turn.sessionId, (item) => { if (item.turnId === turn.id) items.push(item); });
    return conversationFileChanges(items, turn.sessionId).length > 0;
  }

  /** What the check would look at, when everything says it may run. The transcript is read last: it costs the most. */
  private target(turn: DaemonTurn): { readonly origin: string; readonly providerId: string } | undefined {
    const { sessionId } = turn;
    const snapshot = this.deps.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.sessionId === sessionId);
    if (!agent || !this.deps.listed(sessionId) || !this.personSent(snapshot, turn)) return undefined;
    if (latestFinishedTurn(snapshot.turns, sessionId)?.id !== turn.id || conversationBusy(snapshot, sessionId)) return undefined;
    if (snapshot.approvals.some((approval) => approval.sessionId === sessionId && approval.state === 'pending')) return undefined;
    if (snapshot.usageLimits?.[sessionId]) return undefined;
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    if (turnWrapUpPauses(snapshot, nowMs).some((pause) => pause.providerId === agent.providerId)) return undefined;
    const pane = this.deps.pane(sessionId);
    if (!pane?.url || (pane.site !== 'local' && pane.site !== 'file') || pane.fault || pane.needsReopen) return undefined;
    return this.changedFiles(turn) ? { origin: originOf(pane.url), providerId: agent.providerId } : undefined;
  }

  private async send(turn: DaemonTurn, browserCheck: { readonly origin: string; readonly providerId: string }): Promise<void> {
    const { deps } = this;
    for (let tries = 0; tries < SEND_TRIES; tries += 1) {
      const commandId = (deps.createId ?? randomUUID)();
      try {
        const receipt = await deps.execute(createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision: deps.getSnapshot().revision,
          issuedAt: (deps.now?.() ?? new Date()).toISOString(),
          principal: { kind: 'cli', id: BROWSER_CHECK_PRINCIPAL },
          type: 'agent.submit',
          payload: { sessionId: turn.sessionId, prompt: BROWSER_CHECK_PROMPT, browserCheck },
        }));
        if (receipt.ok || receipt.error.code !== 'revision-conflict') return;
      } catch {
        return; // The check is a courtesy: the conversation goes on without it.
      }
    }
  }
}
