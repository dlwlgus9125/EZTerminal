import { Bot, MessageSquare, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { AgentLaunchBootstrap, AgentProjectLauncherSummary } from '../shared/agent-history';
import type { EzTerminalApi } from '../shared/ipc';
import type { NewSessionDraftIntent } from '../shared/session-navigation';
import { useAppTranslation } from './i18n';
import { Button, Field, Select } from './ui';
import './session-start.css';

export function useSessionCopy() {
  const { i18n } = useAppTranslation();
  return (i18n.resolvedLanguage ?? i18n.language).startsWith('ko') ? {
    title: '새 세션', kind: '세션 종류', mode: 'Agent 실행 방식', agent: 'Agent', terminal: '터미널',
    conversation: '앱에서 대화', cli: '터미널 CLI', project: '프로젝트', workspace: '작업 폴더',
    selectProject: '프로젝트 선택', selectWorkspace: '작업 폴더 선택', local: '일반 터미널 (기본 폴더)',
    openTerminal: '터미널 열기', launch: 'Agent 실행', launcher: 'CLI 에이전트', chooseLauncher: '실행할 CLI 선택',
    noLaunchers: '사용 가능한 CLI가 없습니다. 데스크톱 설정 → Agents에서 설치와 실행기를 확인하세요.',
    setup: 'Agent 설정 열기', noProvider: '사용 가능한 대화형 Agent가 없습니다. 데스크톱 설정 → Agents에서 설정을 완료하세요.',
    failed: '세션을 열지 못했습니다. 실행 위치와 연결 상태를 확인하고 다시 시도하세요.',
    stale: '선택한 작업 폴더를 사용할 수 없습니다. 프로젝트와 접근 상태를 확인하세요.',
    retry: '다시 시도', cliHint: '선택한 작업 폴더의 새 터미널에서 실행합니다.',
    terminalHint: '명령을 직접 입력할 수 있는 일반 터미널을 엽니다.',
    loading: '실행기 확인 중…', folder: '호스트 폴더 경로', direct: '직접 폴더 선택',
  } : {
    title: 'New session', kind: 'Session type', mode: 'Agent interface', agent: 'Agent', terminal: 'Terminal',
    conversation: 'Chat in app', cli: 'Terminal CLI', project: 'Project', workspace: 'Workspace',
    selectProject: 'Select a project', selectWorkspace: 'Select a workspace', local: 'Local terminal (default folder)',
    openTerminal: 'Open terminal', launch: 'Start Agent', launcher: 'CLI Agent', chooseLauncher: 'Select a CLI',
    noLaunchers: 'No CLI is available. Check installation and launchers in Desktop Settings → Agents.',
    setup: 'Open Agent settings', noProvider: 'No conversational Agent is ready. Complete setup in Desktop Settings → Agents.',
    failed: 'The session could not be opened. Check its location and connection, then retry.',
    stale: 'The selected workspace is unavailable. Check the project and its access.',
    retry: 'Retry', cliHint: 'Starts in a new terminal at the selected workspace.',
    terminalHint: 'Open a regular terminal to enter commands directly.',
    loading: 'Checking launchers…', folder: 'Host folder path', direct: 'Choose a folder',
  };
}

export function SessionStartOptions({ kind, agentMode, onKindChange, onModeChange, locked = false, prefix = 'new-session' }: {
  readonly kind: NewSessionDraftIntent['kind'];
  readonly agentMode: NewSessionDraftIntent['agentMode'];
  readonly onKindChange: (kind: NewSessionDraftIntent['kind']) => void;
  readonly onModeChange: (mode: NewSessionDraftIntent['agentMode']) => void;
  readonly locked?: boolean;
  readonly prefix?: string;
}): JSX.Element {
  const copy = useSessionCopy();
  return <div className="session-start-options">
    <div className="session-start-options__choices" role="group" aria-label={copy.kind}>
      <Button leadingIcon={<Bot />} aria-pressed={kind === 'agent'} disabled={locked} onClick={() => onKindChange('agent')} data-testid={`${prefix}-agent`}>{copy.agent}</Button>
      <Button leadingIcon={<SquareTerminal />} aria-pressed={kind === 'terminal'} disabled={locked} onClick={() => onKindChange('terminal')} data-testid={`${prefix}-terminal`}>{copy.terminal}</Button>
    </div>
    {kind === 'agent' && <div className="session-start-options__choices" role="group" aria-label={copy.mode}>
      <Button leadingIcon={<MessageSquare />} aria-pressed={agentMode === 'conversation'} disabled={locked} onClick={() => onModeChange('conversation')} data-testid={`${prefix}-conversation`}>{copy.conversation}</Button>
      <Button leadingIcon={<SquareTerminal />} aria-pressed={agentMode === 'cli'} disabled={locked} onClick={() => onModeChange('cli')} data-testid={`${prefix}-cli`}>{copy.cli}</Button>
    </div>}
  </div>;
}

export type SessionLaunchAccess = Pick<EzTerminalApi, 'getDaemonSnapshot' | 'listAgentProjectLaunchers' | 'prepareAgentLaunch'>;

export function CliAgentLaunchPanel({ access, workspaceId, directory, disabled, onLaunch, onSettings, onBusyChange }: {
  readonly access: SessionLaunchAccess;
  readonly workspaceId?: string;
  readonly directory?: string;
  readonly disabled?: boolean;
  readonly onLaunch: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
  readonly onSettings?: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const copy = useSessionCopy();
  const [launchers, setLaunchers] = useState<readonly AgentProjectLauncherSummary[]>([]);
  const [launcherId, setLauncherId] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.resolve().then(() => access.listAgentProjectLaunchers()).then((items) => {
      if (active) { setLaunchers(items); setError(null); }
    }).catch(() => { if (active) setError(copy.failed); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [access, retry, copy.failed]);
  const launch = async (): Promise<void> => {
    if (busyRef.current || disabled || !launcherId || (!workspaceId && !directory)) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      let cwd = directory;
      if (workspaceId) {
        const snapshot = await access.getDaemonSnapshot();
        const workspace = snapshot?.workspaces.find((item) => item.id === workspaceId && !item.archivedAt);
        if (!workspace || !snapshot?.projects.some((item) => item.id === workspace.projectId && !item.archivedAt)) throw new Error(copy.stale);
        cwd = workspace.rootPath;
      }
      if (!cwd) throw new Error(copy.stale);
      const result = await access.prepareAgentLaunch({ kind: 'directory', directory: cwd }, launcherId);
      if (!result.ok) throw new Error(copy.failed);
      await onLaunch({ kind: 'new-chat', target: result.target, launcherId: result.launcherId, provider: result.provider, name: result.name, cwd: result.cwd, revision: result.revision });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : copy.failed);
    } finally { busyRef.current = false; setBusy(false); onBusyChange?.(false); }
  };
  return <section className="session-start-cli" aria-label={copy.cli}>
    <p>{copy.cliHint}</p>
    <Field label={copy.launcher} required>
      <Select value={launcherId} disabled={loading || busy || disabled} onChange={(event) => setLauncherId(event.currentTarget.value)} data-testid="session-cli-launcher">
        <option value="">{copy.chooseLauncher}</option>
        {launchers.map((item) => <option value={item.launcherId} key={item.launcherId}>{item.name}</option>)}
      </Select>
    </Field>
    {loading && <p role="status">{copy.loading}</p>}
    {!loading && launchers.length === 0 && <p role="status">{copy.noLaunchers}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="session-start-options__choices">
      <Button variant="primary" loading={busy} disabled={disabled || loading || !launcherId || (!workspaceId && !directory)} onClick={() => void launch()} data-testid="session-cli-start">{copy.launch}</Button>
      {!loading && (error || launchers.length === 0) && <Button onClick={() => setRetry((value) => value + 1)}>{copy.retry}</Button>}
      {onSettings && <Button variant="ghost" disabled={busy} onClick={onSettings}>{copy.setup}</Button>}
    </div>
  </section>;
}
