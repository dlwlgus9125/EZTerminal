import { RefreshCw, SquareTerminal, Trash2 } from 'lucide-react';
import type { AgentLaunchBootstrap } from '../../src/shared/agent-history';
import { CliAgentLaunchPanel, SessionStartOptions, type SessionLaunchAccess } from '../../src/renderer/SessionStartOptions';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  StructuredAgentDraftPanel,
  type StructuredAgentDraftInput,
  type StructuredAgentUiResult,
  type StructuredAgentWorkspaceOption,
} from '../../src/renderer/StructuredAgentSession';
import { structuredAgentProviderOptions } from '../../src/renderer/structured-agent-create';
import { useAppTranslation } from '../../src/renderer/i18n';
import { Button, Dialog, Field, Select } from '../../src/renderer/ui';
import { MobilePageHeader } from './MobilePageHeader';
import type { MobileAgentCreateRecoveryStatus } from './mobile-agent-create-recovery-store';
import type { DaemonRuntimeViewState } from './transport/ws-ezterminal';

export type MobileNewSessionKind = 'agent' | 'terminal';

interface MobileNewSessionCopy {
  readonly title: string;
  readonly description: string;
  readonly sessionType: string;
  readonly agent: string;
  readonly terminal: string;
  readonly project: string;
  readonly workspace: string;
  readonly selectProject: string;
  readonly selectWorkspace: string;
  readonly location: string;
  readonly locationHint: string;
  readonly terminalDescription: string;
  readonly openTerminal: string;
  readonly openingTerminal: string;
  readonly terminalFailed: string;
  readonly unavailable: string;
  readonly reconnecting: string;
  readonly safeMode: string;
  readonly retry: string;
  readonly providerRecovery: string;
  readonly deliveryRecovery: string;
  readonly recoveryLoading: string;
  readonly recoveryUnavailable: string;
  readonly recoveryInvalid: string;
  readonly discardRecovery: string;
  readonly discardTitle: string;
  readonly discardDescription: string;
  readonly cancel: string;
  readonly discard: string;
  readonly noProjects: string;
  readonly noWorkspaces: string;
  readonly local: string;
  readonly worktree: string;
}

const COPY: Readonly<Record<'en' | 'ko', MobileNewSessionCopy>> = {
  en: {
    title: 'New session',
    description: 'Choose a session type and the exact workspace where it will run.',
    sessionType: 'Session type',
    agent: 'Agent',
    terminal: 'Terminal',
    project: 'Project',
    workspace: 'Workspace',
    selectProject: 'Select a project',
    selectWorkspace: 'Select a workspace',
    location: 'Location',
    locationHint: 'The host revalidates this workspace immediately before creating the session.',
    terminalDescription: 'Open an interactive terminal at the selected workspace root.',
    openTerminal: 'Open Terminal',
    openingTerminal: 'Opening Terminal',
    terminalFailed: 'The Terminal session could not be opened.',
    unavailable: 'The desktop session authority is unavailable.',
    reconnecting: 'Reconnecting and checking the latest workspace state…',
    safeMode: 'Agent sessions are unavailable in terminal-only safe mode. Use the Terminal tab for a default Terminal.',
    retry: 'Retry',
    providerRecovery: 'No ready Agent provider is available. Finish provider setup in Desktop Settings → Agents. Terminal creation remains available.',
    deliveryRecovery: 'The previous Send was not confirmed. This exact Agent draft is locked; Send again to verify or safely retry the same session.',
    recoveryLoading: 'Checking secure Agent recovery before creation. Terminal creation remains available.',
    recoveryUnavailable: 'Secure Agent recovery storage is unavailable. Agent creation is disabled to prevent a duplicate session. Terminal creation remains available.',
    recoveryInvalid: 'The pending Agent recovery record is damaged and cannot be replayed. Terminal remains available.',
    discardRecovery: 'Discard recovery',
    discardTitle: 'Discard pending Agent recovery?',
    discardDescription: 'The exact command cannot be recovered. If it already reached Desktop, creating another Agent later could duplicate the work.',
    cancel: 'Cancel',
    discard: 'Discard',
    noProjects: 'No active projects are available. Create a Project on Desktop first.',
    noWorkspaces: 'This Project has no active Workspace.',
    local: 'Local',
    worktree: 'Worktree',
  },
  ko: {
    title: '새 세션',
    description: '세션 유형과 실제 작업을 실행할 Workspace를 선택하세요.',
    sessionType: '세션 유형',
    agent: 'Agent',
    terminal: 'Terminal',
    project: 'Project',
    workspace: 'Workspace',
    selectProject: 'Project 선택',
    selectWorkspace: 'Workspace 선택',
    location: '실행 위치',
    locationHint: '세션 생성 직전에 호스트가 이 Workspace를 다시 검증합니다.',
    terminalDescription: '선택한 Workspace 루트에서 대화형 Terminal을 엽니다.',
    openTerminal: 'Terminal 열기',
    openingTerminal: 'Terminal 여는 중',
    terminalFailed: 'Terminal 세션을 열지 못했습니다.',
    unavailable: '데스크톱 세션 권한에 연결할 수 없습니다.',
    reconnecting: '다시 연결하고 최신 Workspace 상태를 확인하는 중…',
    safeMode: 'Terminal 전용 안전 모드에서는 Agent 세션을 만들 수 없습니다. 기본 Terminal은 Terminal 탭에서 열어 주세요.',
    retry: '다시 시도',
    providerRecovery: '사용 가능한 Agent Provider가 없습니다. Desktop 설정 → Agents에서 설정을 완료하세요. Terminal 생성은 계속 사용할 수 있습니다.',
    deliveryRecovery: '이전 Send 결과를 확인할 수 없습니다. 중복 세션을 막기 위해 이 Agent 초안을 잠갔습니다. 같은 세션을 확인하거나 안전하게 재시도하려면 다시 Send 하세요.',
    recoveryLoading: 'Agent 생성 전에 안전한 복구 저장소를 확인하고 있습니다. Terminal 생성은 계속 사용할 수 있습니다.',
    recoveryUnavailable: '안전한 Agent 복구 저장소를 사용할 수 없습니다. 중복 세션 생성을 막기 위해 Agent 생성이 비활성화되었습니다. Terminal 생성은 계속 사용할 수 있습니다.',
    recoveryInvalid: '대기 중인 Agent 복구 레코드가 손상되어 같은 명령을 재생할 수 없습니다. Terminal은 계속 사용할 수 있습니다.',
    discardRecovery: '복구 기록 폐기',
    discardTitle: '대기 중인 Agent 복구 기록을 폐기할까요?',
    discardDescription: '정확한 명령을 복원할 수 없습니다. 명령이 이미 Desktop에 도달했다면 나중에 새 Agent를 만들 때 작업이 중복될 수 있습니다.',
    cancel: '취소',
    discard: '폐기',
    noProjects: '활성 Project가 없습니다. Desktop에서 Project를 먼저 만들어 주세요.',
    noWorkspaces: '이 Project에는 활성 Workspace가 없습니다.',
    local: 'Local',
    worktree: 'Worktree',
  },
};

export function MobileNewSessionDraft({
  state,
  disconnected = false,
  contextWorkspaceId,
  initialAgentDraft,
  agentRecoveryStatus,
  onBack,
  onRetry,
  onRetryAgentRecovery,
  onDiscardAgentRecovery,
  onCreateAgent,
  onCreateTerminal,
  onCreateLocalTerminal,
  launchAccess,
  onLaunchCli,
}: {
  readonly state: DaemonRuntimeViewState;
  readonly disconnected?: boolean;
  readonly contextWorkspaceId?: string;
  /** Restores the exact logical draft while reconciling an uncertain delivery. */
  readonly initialAgentDraft?: StructuredAgentDraftInput;
  readonly agentRecoveryStatus: MobileAgentCreateRecoveryStatus;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly onRetryAgentRecovery?: () => void;
  readonly onDiscardAgentRecovery?: () => void;
  readonly onCreateAgent: (input: StructuredAgentDraftInput) => Promise<StructuredAgentUiResult>;
  readonly onCreateTerminal: (workspaceId: string) => Promise<StructuredAgentUiResult>;
  readonly onCreateLocalTerminal?: () => Promise<StructuredAgentUiResult>;
  readonly launchAccess?: SessionLaunchAccess;
  readonly onLaunchCli?: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
}): JSX.Element {
  const { i18n, t } = useAppTranslation();
  const language: 'en' | 'ko' = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko')
    ? 'ko'
    : 'en';
  const copy = COPY[language];
  const snapshot = state.snapshot;
  const safeMode = state.availability?.state === 'legacy-only-safe-mode';
  const busyAuthority = disconnected || safeMode || state.status !== 'ready' || !snapshot;
  const projects = useMemo(
    () => (snapshot?.projects ?? []).filter((project) => project.archivedAt === undefined),
    [snapshot],
  );
  const activeWorkspaces = useMemo(
    () => {
      const activeProjectIds = new Set(projects.map((project) => project.id));
      return (snapshot?.workspaces ?? []).filter((workspace) => (
        workspace.archivedAt === undefined && activeProjectIds.has(workspace.projectId)
      ));
    },
    [projects, snapshot],
  );
  const contextWorkspace = contextWorkspaceId
    ? activeWorkspaces.find((workspace) => workspace.id === contextWorkspaceId)
    : undefined;
  const [kind, setKind] = useState<MobileNewSessionKind>('agent');
  const [agentMode, setAgentMode] = useState<'conversation' | 'cli'>('conversation');
  const recoveredWorkspace = initialAgentDraft
    ? snapshot?.workspaces.find((workspace) => workspace.id === initialAgentDraft.workspaceId)
    : undefined;
  const [projectId, setProjectId] = useState(
    contextWorkspace?.projectId ?? recoveredWorkspace?.projectId ?? '',
  );
  const [workspaceId, setWorkspaceId] = useState(
    contextWorkspace?.id ?? recoveredWorkspace?.id ?? '',
  );
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const terminalLock = useRef(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [discardRecoveryOpen, setDiscardRecoveryOpen] = useState(false);
  const discardRecoveryCancelRef = useRef<HTMLButtonElement>(null);
  const providers = useMemo(() => structuredAgentProviderOptions(snapshot), [snapshot]);
  const readyProvider = providers.some((provider) => !provider.disabled);
  const projectWorkspaces = useMemo<readonly StructuredAgentWorkspaceOption[]>(() => {
    const options = activeWorkspaces
      .filter((workspace) => workspace.projectId === projectId)
      .map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        kind: workspace.kind,
        path: workspace.rootPath,
      }));
    if (
      initialAgentDraft
      && recoveredWorkspace
      && recoveredWorkspace.projectId === projectId
      && !options.some((workspace) => workspace.id === recoveredWorkspace.id)
    ) {
      options.push({
        id: recoveredWorkspace.id,
        label: recoveredWorkspace.name,
        kind: recoveredWorkspace.kind,
        path: recoveredWorkspace.rootPath,
      });
    }
    return options;
  }, [activeWorkspaces, initialAgentDraft, projectId, recoveredWorkspace]);
  const selectedWorkspace = snapshot?.workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedProject = snapshot?.projects.find((project) => project.id === projectId);
  const lockedLocation = contextWorkspaceId !== undefined || initialAgentDraft !== undefined;

  useEffect(() => {
    if (!contextWorkspaceId) return;
    const next = activeWorkspaces.find((workspace) => workspace.id === contextWorkspaceId);
    setProjectId(next?.projectId ?? '');
    setWorkspaceId(next?.id ?? '');
  }, [activeWorkspaces, contextWorkspaceId]);

  useEffect(() => {
    if (!initialAgentDraft) return;
    setKind('agent');
    setAgentMode('conversation');
    setProjectId(recoveredWorkspace?.projectId ?? '');
    setWorkspaceId(initialAgentDraft.workspaceId);
    setTerminalError(null);
  }, [initialAgentDraft, recoveredWorkspace?.projectId]);

  useEffect(() => {
    if (initialAgentDraft) return;
    if (!workspaceId || activeWorkspaces.some((workspace) => workspace.id === workspaceId)) return;
    setWorkspaceId('');
  }, [activeWorkspaces, initialAgentDraft, workspaceId]);

  const authorityMessage = safeMode
    ? copy.safeMode
    : disconnected || state.status === 'error'
      ? copy.unavailable
      : state.status === 'loading' || state.status === 'recovering'
        ? copy.reconnecting
        : null;

  const createTerminal = async (): Promise<void> => {
    if (terminalLock.current || initialAgentDraft || disconnected || (projectId !== 'local' && (!workspaceId || busyAuthority))) return;
    const create = projectId === 'local' ? onCreateLocalTerminal : () => onCreateTerminal(workspaceId);
    if (!create) return;
    terminalLock.current = true;
    setTerminalBusy(true);
    setTerminalError(null);
    const result = await create().catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.terminalFailed,
    }));
    setTerminalBusy(false);
    terminalLock.current = false;
    if (!result.ok) setTerminalError(result.message);
  };

  return (
    <>
      <main className="mob-page mob-new-session" data-testid="mobile-new-session-draft">
      <MobilePageHeader
        title={copy.title}
        backLabel={t('common.back')}
        backTestId="mobile-new-session-back"
        onBack={() => { if (!terminalBusy && !agentBusy) onBack(); }}
      />

      <div className="mob-new-session__scroll">
        <div className="mob-new-session__content">
          <header className="mob-new-session__intro">
            <p>{copy.description}</p>
          </header>

          <SessionStartOptions kind={kind} agentMode={agentMode} onKindChange={setKind} onModeChange={setAgentMode} locked={initialAgentDraft !== undefined || terminalBusy || agentBusy} prefix="mobile-new-session" />

          {authorityMessage && (
            <div className="mob-new-session__notice" role={state.status === 'error' ? 'alert' : 'status'}>
              <span>{authorityMessage}</span>
              {!safeMode && !disconnected && state.status === 'error' && (
                <Button variant="ghost" size="sm" leadingIcon={<RefreshCw />} onClick={onRetry}>
                  {copy.retry}
                </Button>
              )}
            </div>
          )}

          <section className="mob-new-session__location" aria-label={copy.location}>
            <div className="mob-new-session__section-copy">
              <strong>{copy.location}</strong>
              <small>{copy.locationHint}</small>
            </div>
            {lockedLocation ? (
              <div className="mob-new-session__locked-location" data-testid="mobile-new-session-locked-workspace">
                <strong>{selectedProject?.name ?? copy.project} · {selectedWorkspace?.name ?? copy.workspace}</strong>
                {selectedWorkspace?.rootPath && <small title={selectedWorkspace.rootPath}>{selectedWorkspace.rootPath}</small>}
              </div>
            ) : (
              <div className="mob-new-session__location-grid">
                <Field label={copy.project} required>
                  <Select
                    value={projectId}
                    disabled={disconnected || terminalBusy || agentBusy}
                    onChange={(event) => {
                      setProjectId(event.currentTarget.value);
                      setWorkspaceId('');
                      setTerminalError(null);
                    }}
                    data-testid="mobile-new-session-project"
                  >
                    <option value="">{projects.length === 0 ? copy.noProjects : copy.selectProject}</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    {onCreateLocalTerminal && <option value="local">{language === 'ko' ? '일반 터미널 (기본 폴더)' : 'Local terminal (default folder)'}</option>}
                  </Select>
                </Field>
                <Field label={copy.workspace} required>
                  <Select
                    value={workspaceId}
                    disabled={busyAuthority || !projectId || projectWorkspaces.length === 0 || terminalBusy || agentBusy}
                    onChange={(event) => {
                      setWorkspaceId(event.currentTarget.value);
                      setTerminalError(null);
                    }}
                    data-testid="mobile-new-session-workspace"
                  >
                    <option value="">{projectId && projectWorkspaces.length === 0 ? copy.noWorkspaces : copy.selectWorkspace}</option>
                    {projectWorkspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.label} · {workspace.kind === 'worktree' ? copy.worktree : copy.local}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </section>

          <div hidden={kind !== 'agent' || agentMode !== 'conversation'} data-testid="mobile-new-session-agent-panel">
            {agentRecoveryStatus !== 'ready' && (
              <div
                className="mob-new-session__provider-recovery"
                role={agentRecoveryStatus === 'loading' ? 'status' : 'alert'}
                data-testid="mobile-new-session-recovery-status"
              >
                <span>
                  {agentRecoveryStatus === 'loading'
                    ? copy.recoveryLoading
                    : agentRecoveryStatus === 'invalid'
                      ? copy.recoveryInvalid
                      : copy.recoveryUnavailable}
                </span>
                {agentRecoveryStatus !== 'loading' && (
                  <div className="mob-new-session__recovery-actions">
                    {onRetryAgentRecovery && (
                      <Button
                        variant="ghost"
                        size="sm"
                        leadingIcon={<RefreshCw />}
                        onClick={onRetryAgentRecovery}
                        data-testid="mobile-new-session-recovery-retry"
                      >
                        {copy.retry}
                      </Button>
                    )}
                    {agentRecoveryStatus === 'invalid' && onDiscardAgentRecovery && (
                      <Button
                        variant="danger"
                        size="sm"
                        leadingIcon={<Trash2 />}
                        onClick={() => setDiscardRecoveryOpen(true)}
                        data-testid="mobile-new-session-recovery-discard"
                      >
                        {copy.discardRecovery}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {initialAgentDraft && (
              <p className="mob-new-session__provider-recovery" role="status" data-testid="mobile-new-session-delivery-recovery">
                {copy.deliveryRecovery}
              </p>
            )}
            {!readyProvider && (
              <p className="mob-new-session__provider-recovery" role="status">
                {copy.providerRecovery}
              </p>
            )}
            <StructuredAgentDraftPanel
              embedded
              hideWorkspaceField
              variant="mobile"
              providers={providers}
              workspaces={projectWorkspaces}
              selectedWorkspaceId={workspaceId}
              initialProviderId={initialAgentDraft?.providerId}
              initialModel={initialAgentDraft?.model}
              initialPermissionPreset={initialAgentDraft?.permissionPreset}
              initialPrompt={initialAgentDraft?.initialPrompt}
              deliveryRecovery={initialAgentDraft !== undefined}
              loading={busyAuthority || agentRecoveryStatus !== 'ready'}
              onRetry={onRetry}
              onCreate={onCreateAgent}
              onBusyChange={setAgentBusy}
            />
          </div>

          {launchAccess && onLaunchCli && <div hidden={kind !== 'agent' || agentMode !== 'cli'}>
            <CliAgentLaunchPanel access={launchAccess} workspaceId={workspaceId} disabled={busyAuthority || terminalBusy || initialAgentDraft !== undefined} onLaunch={onLaunchCli} onBusyChange={setAgentBusy} />
          </div>}
          {(!launchAccess || !onLaunchCli) && kind === 'agent' && agentMode === 'cli' && <p role="status">{copy.unavailable}</p>}

          <div hidden={kind !== 'terminal'} data-testid="mobile-new-session-terminal-panel">
            <section className="mob-new-session__terminal">
              <SquareTerminal aria-hidden="true" />
              <div>
                <h2>{copy.terminal}</h2>
                <p>{copy.terminalDescription}</p>
                {selectedWorkspace?.rootPath && <code>{selectedWorkspace.rootPath}</code>}
              </div>
            </section>
            {terminalError && <p className="structured-agent__form-error" role="alert">{terminalError}</p>}
            <div className="mob-new-session__terminal-action">
              <Button
                variant="primary"
                size="lg"
                leadingIcon={<SquareTerminal />}
                loading={terminalBusy}
                loadingLabel={copy.openingTerminal}
                disabled={disconnected || initialAgentDraft !== undefined || (projectId !== 'local' && (busyAuthority || !workspaceId))}
                onClick={() => void createTerminal()}
                data-testid="mobile-new-session-open-terminal"
              >
                {copy.openTerminal}
              </Button>
            </div>
          </div>
        </div>
      </div>
      </main>
      <Dialog
        open={discardRecoveryOpen}
        onOpenChange={setDiscardRecoveryOpen}
        role="alertdialog"
        title={copy.discardTitle}
        description={copy.discardDescription}
        initialFocusRef={discardRecoveryCancelRef}
        footer={(
          <>
            <Button ref={discardRecoveryCancelRef} onClick={() => setDiscardRecoveryOpen(false)}>
              {copy.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscardRecoveryOpen(false);
                onDiscardAgentRecovery?.();
              }}
              data-testid="mobile-new-session-recovery-discard-confirm"
            >
              {copy.discard}
            </Button>
          </>
        )}
      >
        <span>{copy.recoveryInvalid}</span>
      </Dialog>
    </>
  );
}
