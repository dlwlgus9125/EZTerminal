import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import { parseTranscriptPayload, type ReviewPayload } from '../shared/transcript-payload';

/**
 * The review loop's host side as the conversation screens use it (`review-loop-v1`), shared by the
 * desktop tab and the phone: what a card's id refers to in the transcript.
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
