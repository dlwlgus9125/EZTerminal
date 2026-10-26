import {
  AgentSideQuestionRequestSchema,
  SIDE_QUESTION_HOST_TIMEOUT_MS,
  type AgentSideQuestionResult,
  type SideQuestionExchange,
} from '../shared/agent-side-question';
import { ProviderSideQuestionError, type ProviderSideQuestionAnswer } from './agent-provider-adapter';

/**
 * Host entry for /btw from the desktop renderer and the remote bridge. Validates, bounds time and
 * concurrency, and maps failures to codes. It never logs or stores the question or the answer.
 */
export interface AgentSideQuestionHost {
  ask(request: unknown, signal: AbortSignal): Promise<AgentSideQuestionResult>;
}

export interface AgentSideQuestionHostOptions {
  readonly ready: () => Promise<unknown>;
  readonly available: () => boolean;
  readonly ask: (
    input: { readonly sessionId: string; readonly question: string; readonly history: readonly SideQuestionExchange[] },
    signal: AbortSignal,
  ) => Promise<ProviderSideQuestionAnswer>;
  readonly timeoutMs?: number;
  readonly maxInFlight?: number;
}

export function createAgentSideQuestionHost(options: AgentSideQuestionHostOptions): AgentSideQuestionHost {
  const timeoutMs = options.timeoutMs ?? SIDE_QUESTION_HOST_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? 8;
  let inFlight = 0;
  return {
    async ask(request, signal) {
      const parsed = AgentSideQuestionRequestSchema.safeParse(request);
      if (!parsed.success) return { ok: false, code: 'invalid' };
      if (inFlight >= maxInFlight) return { ok: false, code: 'busy' };
      inFlight += 1;
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      try {
        await Promise.race([
          options.ready(),
          new Promise((_resolve, reject) => combined.addEventListener('abort', () => reject(combined.reason), { once: true })),
        ]);
        // A cancel that lands while `ready` settles must not reach the provider as a spent signal.
        combined.throwIfAborted();
        if (!options.available()) return { ok: false, code: 'unavailable' };
        const { sessionId, question, history } = parsed.data;
        const answer = await options.ask({ sessionId, question, history }, combined);
        return {
          ok: true,
          answer: answer.text,
          synthetic: answer.synthetic,
          ...(answer.fallbackNotice ? { fallbackNotice: answer.fallbackNotice.slice(0, 400) } : {}),
        };
      } catch (error) {
        if (timeout.aborted && !signal.aborted) return { ok: false, code: 'timeout' };
        if (signal.aborted) return { ok: false, code: 'cancelled' };
        if (error instanceof ProviderSideQuestionError) return { ok: false, code: error.code };
        return { ok: false, code: 'failed' };
      } finally {
        inFlight -= 1;
      }
    },
  };
}
