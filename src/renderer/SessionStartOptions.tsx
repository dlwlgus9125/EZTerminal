import { Bot, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { AgentLaunchBootstrap, AgentProjectLauncherSummary } from '../shared/agent-history';
import type { EzTerminalApi } from '../shared/ipc';
import type { NewSessionDraftIntent } from '../shared/session-navigation';
import { useAppTranslation } from './i18n';
import { Button, Field, Input, Select } from './ui';
import './session-start.css';

export function useSessionCopy() {
  const { i18n } = useAppTranslation();
  return (i18n.resolvedLanguage ?? i18n.language).startsWith('ko') ? {
    title: '새 세션', kind: '세션 종류', mode: 'Agent 실행 방식', agent: 'Agent', terminal: '터미널',
    conversation: '앱에서 대화', cli: '터미널 CLI', project: '프로젝트', workspace: '작업 폴더',
    selectProject: '프로젝트 선택', selectWorkspace: '작업 폴더 선택', local: '일반 터미널 (기본 폴더)',
    openTerminal: '터미널 열기', launch: '터미널 열기', launcher: '실행할 프로그램', chooseLauncher: '실행할 CLI 선택',
    notInstalled: '설치 필요', noLaunchers: '호스트에 CLI를 설치한 뒤 다시 확인하세요.',
    setup: 'Agent 설정', noProvider: '사용할 Agent를 설정하세요.',
    failed: '세션을 열지 못했습니다. 실행 위치와 연결 상태를 확인하고 다시 시도하세요.',
    stale: '선택한 작업 폴더를 사용할 수 없습니다. 프로젝트와 접근 상태를 확인하세요.',
    retry: '다시 시도', cliHint: '선택한 작업 폴더의 새 터미널에서 실행합니다.',
    terminalHint: '명령을 직접 입력할 수 있는 일반 터미널을 엽니다.',
    shell: '일반 셸', model: '모델', defaultModel: 'CLI 기본 모델', customModel: '모델 직접 지정…', modelName: '모델 이름', chooseLocation: 'CLI를 실행할 작업 폴더를 선택하세요.',
    loading: '실행기 확인 중…', folder: '호스트 폴더 경로', direct: '직접 폴더 선택',
  } : {
    title: 'New session', kind: 'Session type', mode: 'Agent interface', agent: 'Agent', terminal: 'Terminal',
    conversation: 'Chat in app', cli: 'Terminal CLI', project: 'Project', workspace: 'Workspace',
    selectProject: 'Select a project', selectWorkspace: 'Select a workspace', local: 'Local terminal (default folder)',
    openTerminal: 'Open terminal', launch: 'Open terminal', launcher: 'Program', chooseLauncher: 'Select a CLI',
    notInstalled: 'Not installed', noLaunchers: 'Install a CLI on the host, then retry.',
    setup: 'Agent settings', noProvider: 'Set up an Agent to continue.',
    failed: 'The session could not be opened. Check its location and connection, then retry.',
    stale: 'The selected workspace is unavailable. Check the project and its access.',
    retry: 'Retry', cliHint: 'Starts in a new terminal at the selected workspace.',
    terminalHint: 'Open a regular terminal to enter commands directly.',
    shell: 'Regular shell', model: 'Model', defaultModel: 'CLI default model', customModel: 'Specify model…', modelName: 'Model name', chooseLocation: 'Choose a workspace for this CLI.',
    loading: 'Checking launchers…', folder: 'Host folder path', direct: 'Choose a folder',
  };
}

export function SessionStartOptions({ kind, onKindChange, locked = false, prefix = 'new-session' }: {
  readonly kind: NewSessionDraftIntent['kind'];
  readonly onKindChange: (kind: NewSessionDraftIntent['kind']) => void;
  readonly locked?: boolean;
  readonly prefix?: string;
}): JSX.Element {
  const copy = useSessionCopy();
  return <div className="session-start-options">
    <div className="session-start-options__choices" role="group" aria-label={copy.kind}>
      <Button leadingIcon={<SquareTerminal />} aria-pressed={kind === 'terminal'} disabled={locked} onClick={() => onKindChange('terminal')} data-testid={`${prefix}-terminal`}>{copy.terminal}</Button>
      <Button leadingIcon={<Bot />} aria-pressed={kind === 'agent'} disabled={locked} onClick={() => onKindChange('agent')} data-testid={`${prefix}-agent`}>{copy.agent}</Button>
    </div>

  </div>;
}

export type SessionLaunchAccess = Pick<EzTerminalApi, 'getDaemonSnapshot' | 'listAgentProjectLaunchers' | 'prepareAgentLaunch'>;

export function TerminalLaunchPanel({ access, workspaceId, directory, disabled, locked, terminalAction, onLaunch, onSettings, onBusyChange }: {
  readonly access?: SessionLaunchAccess;
  readonly locked?: boolean;
  readonly terminalAction: ReactNode;
  readonly workspaceId?: string;
  readonly directory?: string;
  readonly disabled?: boolean;
  readonly onLaunch?: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
  readonly onSettings?: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const copy = useSessionCopy();
  const [launchers, setLaunchers] = useState<readonly AgentProjectLauncherSummary[]>([]);
  const [launcherId, setLauncherId] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedLauncher = launchers.find((entry) => entry.launcherId === launcherId);
  const invalidModel = customModel && (!selectedLauncher?.supportsModel || !model.trim());
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.resolve().then(() => access?.listAgentProjectLaunchers() ?? []).then((items) => {
      if (active) { setLaunchers(items); setCatalogError(false); }
    }).catch(() => { if (active) setCatalogError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [access, retry, copy.failed]);
  const launch = async (): Promise<void> => {
    if (busyRef.current || locked || disabled || !access || !onLaunch || !launcherId || invalidModel || selectedLauncher?.installed === false || (!workspaceId && !directory)) return;
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
      const selectedModel = customModel ? model.trim() : undefined;
      const result = await access.prepareAgentLaunch({ kind: 'directory', directory: cwd }, launcherId, selectedModel);
      if (!result.ok) throw new Error(copy.failed);
      await onLaunch({ kind: 'new-chat', target: result.target, launcherId: result.launcherId, provider: result.provider, name: result.name, cwd: result.cwd, revision: result.revision, ...(selectedModel ? { model: selectedModel } : {}) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : copy.failed);
    } finally { busyRef.current = false; setBusy(false); onBusyChange?.(false); }
  };
  return <section className="session-start-cli" aria-label={copy.terminal}>
    <Field label={copy.launcher} required>
      <Select value={launcherId} disabled={busy || locked} onChange={(event) => { setLauncherId(event.currentTarget.value); setCustomModel(false); setModel(''); setError(null); }} data-testid="session-cli-launcher">
        <option value="">{copy.shell}</option>
        {launchers.map((item) => <option value={item.launcherId} key={item.launcherId} disabled={item.installed === false}>{item.name}{item.installed === false ? ` · ${copy.notInstalled}` : ''}</option>)}
      </Select>
    </Field>
    {launcherId && selectedLauncher?.provider !== 'generic' && <>
      <Field label={copy.model}>
        <Select value={customModel ? 'custom' : 'default'} disabled={busy || locked} onChange={(event) => { setCustomModel(event.currentTarget.value === 'custom'); setModel(''); }} data-testid="session-cli-model">
          <option value="default">{copy.defaultModel}</option>
          <option value="custom" disabled={!selectedLauncher?.supportsModel}>{copy.customModel}</option>
        </Select>
      </Field>
      {customModel && <Field label={copy.modelName} required>
        <Input value={model} maxLength={200} disabled={busy || locked} onChange={(event) => setModel(event.currentTarget.value)} data-testid="session-cli-model-name" />
      </Field>}
    </>}
    {launcherId && !workspaceId && !directory && <p role="status">{copy.chooseLocation}</p>}
    {loading && <p role="status">{copy.loading}</p>}
    {catalogError && <Button variant="ghost" disabled={busy || locked} onClick={() => setRetry((value) => value + 1)}>{copy.retry}</Button>}
    {!loading && !catalogError && access && !launchers.some((item) => item.installed !== false) && <p role="status">{copy.noLaunchers}</p>}
    {error && <p role="alert">{error}</p>}
    {!launcherId ? terminalAction : <div className="session-start-options__choices">
      <Button variant="primary" loading={busy} disabled={locked || disabled || loading || !onLaunch || invalidModel || !launcherId || selectedLauncher?.installed === false || (!workspaceId && !directory)} onClick={() => void launch()} data-testid="session-cli-start">{copy.launch}</Button>
      {!loading && (error || !launchers.some((item) => item.installed !== false)) && <Button onClick={() => setRetry((value) => value + 1)}>{copy.retry}</Button>}
      {onSettings && error && <Button variant="ghost" disabled={busy} onClick={onSettings}>{copy.setup}</Button>}
    </div>}
  </section>;
}
