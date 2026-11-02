import { randomUUID } from 'node:crypto';

import { BROWSER_THUMB_CHARS, type BrowserActionKind, type BrowserRefusal, type BrowserStepKind } from '../shared/browser';
import type { TranscriptPayload } from '../shared/transcript-payload';

/**
 * The conversation's record of the browser, written by the host from what ran: what a model says it did is not evidence.
 * Each row is a notice a client with no browser rows still reads, and sensitive, so a phone keeps none of it offline. A row
 * holds the site and never the address: a query string can carry a token, and rows go to phones.
 */

const PAGE_TEXT_CHARS = 2_000;
const SITE_CHARS = 2_000;

export interface BrowserRowContext {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface BrowserRowItem {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: 'notice';
  readonly text: string;
  readonly isDelta: false;
  readonly isSensitive: true;
  readonly payload: TranscriptPayload;
}

export interface BrowserRowsDeps {
  readonly append: (item: BrowserRowItem) => void;
  readonly createId?: () => string;
}

function siteOf(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.origin === 'null' ? `${parsed.protocol}//${parsed.pathname}` : parsed.origin).slice(0, SITE_CHARS);
  } catch {
    return url.slice(0, SITE_CHARS);
  }
}

export class BrowserRows {
  /** What was said already, by turn: a page looping on a blocked site writes one row. */
  private readonly said = new Map<string, Set<string>>();

  constructor(private readonly deps: BrowserRowsDeps) {}

  step(context: BrowserRowContext, step: { readonly kind: BrowserStepKind; readonly url: string; readonly pageText?: string }): void {
    const origin = siteOf(step.url);
    const pageText = step.pageText?.slice(0, PAGE_TEXT_CHARS);
    this.write(context, `Browser: ${step.kind}, ${origin}`, { v: 1, type: 'browser-step', step: step.kind, origin, ...(pageText ? { pageText } : {}) });
  }

  shot(context: BrowserRowContext, shot: { readonly shotId: string; readonly url: string; readonly thumbBase64?: string }): void {
    const origin = siteOf(shot.url);
    const thumb = shot.thumbBase64 !== undefined && shot.thumbBase64.length <= BROWSER_THUMB_CHARS ? shot.thumbBase64 : undefined;
    this.write(context, `Browser: screenshot, ${origin}`, { v: 1, type: 'browser-shot', shotId: shot.shotId, turnId: context.turnId, origin, ...(thumb ? { thumb } : {}) });
  }

  blocked(context: BrowserRowContext, refusal: { readonly origin: string; readonly reason: BrowserRefusal; readonly action?: BrowserActionKind }): void {
    const said = this.said.get(context.turnId) ?? new Set<string>();
    const key = `${refusal.reason}\n${refusal.origin}`;
    if (said.has(key)) return;
    this.said.set(context.turnId, said.add(key));
    const site = refusal.origin.slice(0, SITE_CHARS);
    this.write(context, `Browser: refused, ${site} (${refusal.reason})`, { v: 1, type: 'browser-blocked', site, reason: refusal.reason, ...(refusal.action ? { action: refusal.action } : {}) });
  }

  turnEnded(turnId: string): void {
    this.said.delete(turnId);
  }

  private write(context: BrowserRowContext, text: string, payload: TranscriptPayload): void {
    try {
      this.deps.append({
        id: (this.deps.createId ?? randomUUID)(), sessionId: context.sessionId, turnId: context.turnId,
        kind: 'notice', text, isDelta: false, isSensitive: true, payload,
      });
    } catch {
      // A row that cannot be written costs the tool nothing: the AI still has its answer.
    }
  }
}
