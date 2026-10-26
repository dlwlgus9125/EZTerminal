import type { AgentSideQuestionClient, AgentSideQuestionRequest, AgentSideQuestionResult } from '../../shared/agent-side-question';

interface SideQuestionApi {
  readonly askSideQuestion?: (request: AgentSideQuestionRequest) => Promise<AgentSideQuestionResult>;
  readonly cancelSideQuestion?: (requestId: string) => void;
}

/**
 * Desktop preload and the Android transport share this: a request id per ask, and an abort that
 * tells the host to stop. Absent when the host side has no side questions.
 */
export function createSideQuestionClient(
  api: SideQuestionApi | undefined,
  newId: () => string = () => crypto.randomUUID(),
): AgentSideQuestionClient | undefined {
  const ask = api?.askSideQuestion?.bind(api);
  if (!ask) return undefined;
  return {
    async ask(input, signal) {
      if (signal.aborted) return { ok: false, code: 'cancelled' };
      const requestId = newId();
      const onAbort = (): void => api?.cancelSideQuestion?.(requestId);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await ask({ requestId, ...input });
        return signal.aborted ? { ok: false, code: 'cancelled' } : result;
      } catch {
        return { ok: false, code: signal.aborted ? 'cancelled' : 'unavailable' };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
