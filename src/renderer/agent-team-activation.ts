import type {
  AgentTeamMemberActivationInput,
  AgentTeamMemberActivationResult,
} from '../shared/agent-team';

interface ActivationDependencies {
  readonly activate: (input: AgentTeamMemberActivationInput) => Promise<AgentTeamMemberActivationResult>;
  readonly onActivitySnapshot: (listener: () => void) => () => void;
}

export async function activateAgentTeamMemberWhenObserved(
  dependencies: ActivationDependencies,
  input: AgentTeamMemberActivationInput,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<Extract<AgentTeamMemberActivationResult, { readonly ok: true }>> {
  const attempt = async (): Promise<Extract<AgentTeamMemberActivationResult, { readonly ok: true }> | null> => {
    const result = await dependencies.activate(input);
    if (result.ok) return result;
    if (result.error === 'unavailable') return null;
    throw new Error(result.message);
  };

  const immediate = await attempt();
  if (immediate) return immediate;
  if (signal.aborted) throw new DOMException('Team activation aborted.', 'AbortError');

  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    const finish = (
      error?: unknown,
      value?: Extract<AgentTeamMemberActivationResult, { readonly ok: true }>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const check = (): void => {
      if (settled || checking) return;
      checking = true;
      void attempt().then((result) => {
        checking = false;
        if (result) finish(undefined, result);
      }).catch((error: unknown) => {
        checking = false;
        finish(error);
      });
    };
    const onAbort = (): void => finish(new DOMException('Team activation aborted.', 'AbortError'));
    const unsubscribe = dependencies.onActivitySnapshot(check);
    const timer = setTimeout(
      () => finish(new Error('The Agent integration did not observe the Team session in time.')),
      Math.max(1, timeoutMs),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}
