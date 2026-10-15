import { createHash } from 'node:crypto';
import type { ExecutionAttempt, ExecutionRun } from '../shared/planning-execution';
export function planningReviewerId(run: ExecutionRun, attempt: ExecutionAttempt, generation = 0): string {
  const hash = createHash('sha256').update(JSON.stringify([run.projectId, run.runId, attempt.attemptId, attempt.artifacts])).digest('hex');
  return `planning-review-${hash.slice(0, 32)}${generation ? `-g${generation}` : ''}`;
}
export function isRunReviewer(run: ExecutionRun, sessionId: string): boolean {
  return run.attempts.some(attempt => { const prefix = planningReviewerId(run, attempt); return sessionId === prefix || sessionId.startsWith(`${prefix}-g`) && /^\d+$/u.test(sessionId.slice(prefix.length + 2)); });
}
