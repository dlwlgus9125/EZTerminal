import { useSyncExternalStore } from 'react';

import type { DaemonTranscriptItem, ManagedAgentState } from '../../shared/daemon-protocol';
import type { ReviewTarget } from '../../shared/review-findings';
import type { ChatReviewAction } from '../chat/ChatContext';
import type { ChatModel } from '../chat/model/types';

/**
 * The conversation tab owns its transcript; its Results tab only reads it.
 * Each conversation publishes what it knows here, keyed by the conversation
 * panel id (stable for the tab's life, also across a draft becoming a
 * session). Pop-out windows share this JavaScript realm, so a Results tab in
 * another window reads the same entry.
 */

export interface ResultsChild {
  readonly sessionId: string;
  readonly title: string;
  readonly providerLabel: string;
  readonly state: ManagedAgentState;
}

export type ResultsSection = 'changes' | 'files' | 'summary';

/** Published by the conversation's dock panel (data it loads and owns). */
export interface ResultsDockPart {
  readonly sessionId: string;
  readonly title: string;
  readonly providerLabel: string;
  readonly workspaceRoot?: string;
  /** The conversation's workspace: 기준 브랜치와 비교 is read for it (the host finds its folder and base). */
  readonly workspaceId?: string;
  readonly items: readonly DaemonTranscriptItem[];
  readonly children: readonly ResultsChild[];
  /** Sequence below the oldest loaded item; 0 once everything is loaded. */
  readonly transcriptFloor: number;
  /** The first page arrived (or the conversation is empty). */
  readonly loaded: boolean;
  /** Head sequence when the conversation first finished loading in this window. */
  readonly baselineSequence: number;
  readonly historyOnly: boolean;
  /** A turn is running; the working-folder view refreshes when it ends. */
  readonly turnActive: boolean;
  /** The conversation works in a worktree off this branch: Changes offers 기준 브랜치와 비교. */
  readonly baseRef?: string;
  /** The messages waiting in the conversation's queue (sent review comments say 대기열 while theirs is there). */
  readonly queuedTexts?: readonly string[];
  readonly readTranscriptPage?: (afterSequence: number, limit: number) => Promise<readonly DaemonTranscriptItem[]>;
  readonly openRelatedSession?: (sessionId: string) => void;
  readonly openProjectFiles?: () => void;
}

/**
 * Review comments sent as their own message: sent now, or queued behind the running turn. `position` is
 * the queue place the host confirmed; the UI never works it out from what it shows.
 */
export type ResultsSendResult =
  | { readonly ok: true; readonly queued: boolean; readonly position?: number }
  | { readonly ok: false; readonly message: string };

/** Published by the conversation panel (what the composer accepts). */
export interface ResultsSessionPart {
  /** Puts text into the composer draft; never sends. Absent when the draft can't change. */
  readonly insertIntoDraft?: (text: string) => void;
  /** Why the draft can't take text (history only, composer busy). */
  readonly draftUnavailable?: 'history' | 'disabled';
  /** Brings the decision above the composer into view. */
  readonly focusDecision?: () => void;
  /** Sends text to the conversation as a message of its own; absent where it cannot send. */
  readonly sendNow?: (text: string) => Promise<ResultsSendResult>;
  /** Review card actions on the host (fix, dismiss, reopen) from the walkthrough. */
  readonly reviewAction?: (action: ChatReviewAction) => void;
  /** Opens the conversation's review start form (the host reviews: `review-loop-v1`), on what is being viewed. */
  readonly openReviewStart?: (start?: ResultsReviewStart) => void;
}

/** What the start form opens on: the changes the person was looking at. */
export interface ResultsReviewStart {
  readonly target?: ReviewTarget;
}

export interface ResultsSource extends Partial<ResultsDockPart>, ResultsSessionPart {
  readonly ownerPanelId: string;
  /** The chat model the conversation already built for its transcript. */
  readonly model?: ChatModel;
}

export interface ResultsNavigation {
  readonly sequence: number;
  readonly section: ResultsSection;
  readonly turnId?: string;
  readonly path?: string;
  readonly line?: number;
  /** Changes: step through an AI review's findings, starting at `findingId` (else the first). */
  readonly review?: { readonly reviewId: string; readonly findingId?: string };
}

interface Entry {
  dock?: ResultsDockPart;
  session?: ResultsSessionPart;
  model?: ChatModel;
  snapshot?: ResultsSource;
  navigation?: ResultsNavigation;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
let navigationSequence = 0;

function entry(ownerPanelId: string): Entry {
  let value = entries.get(ownerPanelId);
  if (!value) { value = {}; entries.set(ownerPanelId, value); }
  return value;
}

function notify(ownerPanelId: string): void {
  for (const listener of [...(listeners.get(ownerPanelId) ?? [])]) listener();
}

function changed(ownerPanelId: string, value: Entry): void {
  value.snapshot = value.dock || value.session || value.model
    ? { ownerPanelId, ...value.dock, ...value.session, ...(value.model ? { model: value.model } : {}) }
    : undefined;
  notify(ownerPanelId);
}

export function publishResultsDock(ownerPanelId: string, part: ResultsDockPart | undefined): void {
  const value = entry(ownerPanelId);
  if (value.dock === part) return;
  // A new conversation in the same tab (/clear) starts with no stale session part.
  if (part && value.dock && value.dock.sessionId !== part.sessionId) { value.session = undefined; value.model = undefined; }
  value.dock = part;
  changed(ownerPanelId, value);
}

export function publishResultsSession(ownerPanelId: string, part: ResultsSessionPart | undefined): void {
  const value = entry(ownerPanelId);
  if (value.session === part) return;
  value.session = part;
  changed(ownerPanelId, value);
}

export function publishResultsModel(ownerPanelId: string, model: ChatModel | undefined): void {
  const value = entry(ownerPanelId);
  if (value.model === model) return;
  value.model = model;
  changed(ownerPanelId, value);
}

/** The conversation tab closed: its Results tab has nothing left to read. */
export function retractResultsSource(ownerPanelId: string): void {
  entries.delete(ownerPanelId);
  notify(ownerPanelId);
}

export function readResultsSource(ownerPanelId: string): ResultsSource | undefined {
  return entries.get(ownerPanelId)?.snapshot;
}

export function subscribeResultsSource(ownerPanelId: string, listener: () => void): () => void {
  let set = listeners.get(ownerPanelId);
  if (!set) { set = new Set(); listeners.set(ownerPanelId, set); }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0 && listeners.get(ownerPanelId) === set) listeners.delete(ownerPanelId);
  };
}

export function useResultsSource(ownerPanelId: string): ResultsSource | undefined {
  return useSyncExternalStore(
    (listener) => subscribeResultsSource(ownerPanelId, listener),
    () => readResultsSource(ownerPanelId),
  );
}

/** Asks the Results tab to show a section (and a turn or file in it). */
export function requestResultsNavigation(ownerPanelId: string, target: Omit<ResultsNavigation, 'sequence'>): void {
  const value = entry(ownerPanelId);
  navigationSequence += 1;
  value.navigation = { ...target, sequence: navigationSequence };
  notify(ownerPanelId);
}

export function readResultsNavigation(ownerPanelId: string): ResultsNavigation | undefined {
  return entries.get(ownerPanelId)?.navigation;
}

export function useResultsNavigation(ownerPanelId: string): ResultsNavigation | undefined {
  return useSyncExternalStore(
    (listener) => subscribeResultsSource(ownerPanelId, listener),
    () => readResultsNavigation(ownerPanelId),
  );
}

/** Tests only. */
export function resetResultsSourcesForTests(): void {
  entries.clear();
  listeners.clear();
  navigationSequence = 0;
}
