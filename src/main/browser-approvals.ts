import { randomUUID } from 'node:crypto';

import type { ApprovalRequest, ApprovalResponse } from '../shared/approval-request';
import { BROWSER_APPROVAL_HOLD_MS, browserActionRequestId, type BrowserActionRun } from '../shared/browser';
import type { DaemonEvent, DaemonSnapshot } from '../shared/daemon-protocol';
import type { BrowserApprovalAnswer, BrowserApprovalRequest } from './browser-tools';

/**
 * A person answering for one browser action. The tool's call holds here, at most 240 s: both clients give up at 300 s.
 * What the person sees is the host's own arguments (the full URL, the value to type, the keys); the element's name comes
 * from the page and is kept apart, in `element`. An answer settles the call, and anything else that ends the approval (the
 * clock, a Stop, the turn ending, the caller going away) settles it as void. The caller then checks the page again.
 */

interface Held {
  readonly conversationId: string;
  readonly origin: string;
  readonly settle: (answer: BrowserApprovalAnswer) => void;
  approvalId?: string;
}

function inputOf(run: BrowserActionRun, pageElement: string | undefined): string {
  const element = pageElement ? { element: pageElement } : {};
  switch (run.kind) {
    case 'click': return JSON.stringify(element);
    case 'navigate': return JSON.stringify({ url: run.url, ...element });
    case 'type': return JSON.stringify({ value: run.value, ...element });
    case 'press': return JSON.stringify({ keys: run.keys, ...element });
  }
}

export interface BrowserApprovalsDeps {
  readonly raise: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly providerRequestId: string;
    readonly risk: 'write';
    readonly title: string;
    readonly request: ApprovalRequest;
  }) => Promise<string | undefined>;
  /** Voids a pending approval, if it still is. */
  readonly expire: (approvalId: string) => Promise<void>;
  readonly getSnapshot: () => Pick<DaemonSnapshot, 'approvals'>;
  readonly onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly createId?: () => string;
}

export class BrowserApprovals {
  private readonly held = new Map<string, Held>();
  /** Sites the person said not to ask about again, by conversation. In memory: it ends with the app. */
  private readonly trusted = new Map<string, Set<string>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: BrowserApprovalsDeps) {
    this.unsubscribe = deps.onEvent((event) => {
      if (event.kind !== 'approval.changed' || this.held.size === 0) return;
      const { approvalId } = event.payload;
      const entry = [...this.held.entries()].find(([, held]) => held.approvalId === approvalId);
      if (!entry) return;
      // A person's answer settles through `resolved`, which also remembers what they chose.
      if (this.deps.getSnapshot().approvals.find((approval) => approval.id === approvalId)?.state === 'expired') entry[1].settle('approval-timeout');
    });
  }

  dispose(): void {
    this.unsubscribe();
    for (const held of [...this.held.values()]) held.settle('approval-timeout');
  }

  siteTrusted(conversationId: string, origin: string): boolean {
    return this.trusted.get(conversationId)?.has(origin) === true;
  }

  /** A revoked site asks again if it is ever allowed again. */
  forgetSite(origin: string): void {
    for (const origins of this.trusted.values()) origins.delete(origin);
  }

  /** The person's answer, after it committed. */
  resolved(providerRequestId: string, decision: 'allow' | 'deny', response?: ApprovalResponse): void {
    const held = this.held.get(providerRequestId);
    if (!held) return;
    if (decision === 'allow' && response?.kind === 'session') {
      const origins = this.trusted.get(held.conversationId) ?? new Set<string>();
      origins.add(held.origin);
      this.trusted.set(held.conversationId, origins);
    }
    held.settle(decision === 'allow' ? 'allow' : 'approval-declined');
  }

  /** 브라우저만 중지: whatever waits on this conversation's page is off. */
  stopped(conversationId: string): void {
    for (const held of [...this.held.values()]) if (held.conversationId === conversationId) held.settle('stopped');
  }

  request(input: BrowserApprovalRequest): Promise<BrowserApprovalAnswer> {
    const providerRequestId = browserActionRequestId((this.deps.createId ?? randomUUID)());
    const setTimer = this.deps.setTimer ?? setTimeout;
    const clearTimer = this.deps.clearTimer ?? clearTimeout;
    return new Promise<BrowserApprovalAnswer>((resolve) => {
      const onAbort = (): void => held.settle('approval-timeout');
      const held: Held = {
        conversationId: input.sessionId,
        origin: input.origin,
        settle: (answer) => {
          if (!this.held.delete(providerRequestId)) return;
          clearTimer(timer);
          input.signal?.removeEventListener('abort', onAbort);
          // What ended without a person's answer must not stay on their screen, or block the turn.
          if (answer !== 'allow' && answer !== 'approval-declined' && held.approvalId) void this.deps.expire(held.approvalId).catch(() => undefined);
          resolve(answer);
        },
      };
      this.held.set(providerRequestId, held);
      const timer = setTimer(() => held.settle('approval-timeout'), BROWSER_APPROVAL_HOLD_MS);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) {
        held.settle('approval-timeout');
        return;
      }
      void this.deps.raise({
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerRequestId,
        risk: 'write',
        title: `${input.tool} on ${input.origin}`,
        request: { v: 1, kind: 'tool', toolName: input.tool, target: input.origin, input: inputOf(input.run, input.pageElement) },
      }).then((approvalId) => {
        // No approval means the turn moved on while this was being raised: nobody can answer it.
        if (!approvalId) {
          held.settle('approval-timeout');
          return;
        }
        held.approvalId = approvalId;
        if (!this.held.has(providerRequestId)) void this.deps.expire(approvalId).catch(() => undefined);
      }, () => held.settle('approval-timeout'));
    });
  }
}
