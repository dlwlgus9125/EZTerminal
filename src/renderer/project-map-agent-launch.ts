import type { AgentActivity, AgentActivitySnapshot } from '../shared/agent';
import type { AgentHistoryProvider } from '../shared/agent-history';
import { isSafeAgentPromptText } from '../shared/agent-coordination';
import {
  projectMapJobPrompt,
  type ProjectMapAgentLaunchRequest,
  type ProjectMapJob,
  type ProjectMapJobRequest,
  type ProjectMapStartJobRequest,
} from '../shared/project-map';

const DEFAULT_ACTIVITY_WAIT_MS = 30_000;
const JOB_ID_SHAPE = '00000000-0000-4000-8000-000000000000';

type ProjectMapJobStartResult =
  | { readonly ok: true; readonly job: ProjectMapJob }
  | { readonly ok: false; readonly error: string };

interface ProjectMapAgentDispatchDependencies {
  readonly getAgentActivitySnapshot: () => Promise<AgentActivitySnapshot>;
  readonly onAgentActivitySnapshot: (listener: (snapshot: AgentActivitySnapshot) => void) => () => void;
  readonly startProjectMapJob: (request: ProjectMapStartJobRequest) => Promise<ProjectMapJobStartResult>;
  readonly cancelProjectMapJob: (request: ProjectMapJobRequest) => Promise<unknown>;
  readonly submitPrompt: (prompt: string) => void;
}

export interface ProjectMapAgentDispatchInput {
  readonly sessionId: string;
  readonly provider: AgentHistoryProvider;
  readonly agentLabel: string;
  readonly request: ProjectMapAgentLaunchRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly dependencies: ProjectMapAgentDispatchDependencies;
}

function abortError(): Error {
  const error = new Error('Project Map Agent dispatch was canceled.');
  error.name = 'AbortError';
  return error;
}

export function waitForProjectMapAgentActivity(
  sessionId: string,
  provider: AgentHistoryProvider,
  dependencies: Pick<
    ProjectMapAgentDispatchDependencies,
    'getAgentActivitySnapshot' | 'onAgentActivitySnapshot'
  >,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_ACTIVITY_WAIT_MS,
): Promise<AgentActivity> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    let unsubscribe = (): void => undefined;
    const finish = (activity?: AgentActivity, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      if (activity) resolve(activity);
      else reject(error ?? new Error('The dedicated Agent activity did not start.'));
    };
    const inspect = (snapshot: AgentActivitySnapshot): void => {
      const activity = snapshot.items
        .filter((candidate) => candidate.live
          && candidate.sessionId === sessionId
          && candidate.provider === provider)
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (activity) finish(activity);
    };
    const onAbort = (): void => finish(undefined, abortError());
    const timer = setTimeout(
      () => finish(undefined, new Error('Timed out waiting for the dedicated Agent activity.')),
      Math.max(1, timeoutMs),
    );
    const subscribed = dependencies.onAgentActivitySnapshot(inspect);
    unsubscribe = subscribed;
    if (settled) unsubscribe();
    signal?.addEventListener('abort', onAbort, { once: true });
    void dependencies.getAgentActivitySnapshot().then(inspect).catch(() => undefined);
  });
}

export async function dispatchProjectMapAgentRequest(
  input: ProjectMapAgentDispatchInput,
): Promise<ProjectMapJob> {
  const { dependencies, request, signal } = input;
  const previewPrompt = projectMapJobPrompt(request.brief, JOB_ID_SHAPE);
  if (!request.brief.trim() || !isSafeAgentPromptText(previewPrompt)) {
    throw new Error('The Project Map brief is empty, too large, or contains unsafe control characters.');
  }

  const activity = await waitForProjectMapAgentActivity(
    input.sessionId,
    input.provider,
    dependencies,
    signal,
    input.timeoutMs,
  );
  if (signal?.aborted) throw abortError();

  const started = await dependencies.startProjectMapJob({
    projectId: request.projectId,
    ownerRootId: request.ownerRootId,
    ownerWorkspaceId: request.ownerWorkspaceId,
    ...(request.mapId ? { mapId: request.mapId } : {}),
    type: request.type,
    intent: request.intent,
    activityId: activity.id,
    dispatch: 'dedicated-session',
    agentLabel: input.agentLabel,
  });
  if (!started.ok) throw new Error(started.error);

  const cancelStartedJob = async (): Promise<void> => {
    await dependencies.cancelProjectMapJob({
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      jobId: started.job.id,
    }).catch(() => undefined);
  };

  try {
    if (signal?.aborted) throw abortError();
    const prompt = projectMapJobPrompt(request.brief, started.job.id);
    if (!isSafeAgentPromptText(prompt)) {
      throw new Error('The Project Map brief could not be submitted safely.');
    }
    dependencies.submitPrompt(prompt);
    return started.job;
  } catch (error) {
    await cancelStartedJob();
    throw error;
  }
}
