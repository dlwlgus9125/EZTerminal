import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentLaunchBootstrap } from '../shared/agent-history';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { NewSessionDraftIntent } from '../shared/session-navigation';
import { StructuredAgentDraftPanel, type StructuredAgentDraftPanelProps, type StructuredAgentUiResult } from './StructuredAgentSession';
import { TerminalLaunchPanel, SessionStartOptions, useSessionCopy, type SessionLaunchAccess } from './SessionStartOptions';
import { Button, Field, Input, Select } from './ui';

export interface NewSessionDraftPanelProps {
  readonly initialIntent?: Pick<NewSessionDraftIntent, 'kind'>;
  readonly snapshot: DaemonSnapshot | null;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly agent: StructuredAgentDraftPanelProps;
  readonly access: SessionLaunchAccess;
  readonly onTerminal: (workspaceId?: string, directory?: string) => Promise<StructuredAgentUiResult>;
  readonly onLaunchCli: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
  readonly onSettings?: () => void;
}

/** A draft is presentation only until Send/Open/Start explicitly commits it. */
export function NewSessionDraftPanel({ initialIntent, snapshot, projectId, workspaceId, agent, access, onTerminal, onLaunchCli, onSettings }: NewSessionDraftPanelProps): JSX.Element {
  const copy = useSessionCopy();
  const [kind, setKind] = useState<NewSessionDraftIntent['kind']>(initialIntent?.kind ?? 'terminal');
  const [selectedProject, setProject] = useState(projectId ?? (initialIntent?.kind === 'agent' ? '' : 'local'));
  const [selectedWorkspace, setWorkspace] = useState(workspaceId ?? '');
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const projects = (snapshot?.projects ?? []).filter((entry) => !entry.archivedAt);
  const workspaces = useMemo(() => (snapshot?.workspaces ?? []).filter((entry) => !entry.archivedAt && entry.projectId === selectedProject), [snapshot, selectedProject]);
  const selected = workspaces.find((entry) => entry.id === selectedWorkspace);
  const recovery = agent.deliveryRecovery === true;
  const locked = recovery || agentBusy;
  useEffect(() => {
    if (workspaceId) setWorkspace(workspaceId);
  }, [workspaceId]);
  useEffect(() => {
    if (recovery && agent.initialWorkspaceId) {
      setKind('agent'); setWorkspace(agent.initialWorkspaceId);
      const owner = snapshot?.workspaces.find((entry) => entry.id === agent.initialWorkspaceId);
      if (owner) setProject(owner.projectId);
    }
  }, [recovery, agent.initialWorkspaceId, snapshot]);
  // A project's main checkout is the contextual default; never silently switch
  // an explicit Workspace when it becomes inaccessible.
  useEffect(() => {
    if (!projectId || workspaceId || selectedWorkspace) return;
    const main = workspaces.find((entry) => entry.kind === 'local');
    if (main) setWorkspace(main.id);
  }, [projectId, workspaceId, selectedWorkspace, workspaces]);
  const openTerminal = async (): Promise<void> => {
    if (busyRef.current || locked || !validLocation) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const result = await onTerminal(selected?.id, selectedProject === 'direct' ? directory.trim() : undefined);
      if (!result.ok) setError(result.message);
    } catch { setError(copy.failed); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const validLocation = Boolean(selected) || (selectedProject === 'local' && kind === 'terminal')
    || (selectedProject === 'direct' && directory.trim().length > 0 && kind === 'terminal');
  return <section className="session-start-draft" data-testid="new-session-draft" aria-label={copy.title}>
    <header><h1>{copy.title}</h1></header>
    <SessionStartOptions kind={kind} locked={locked || busy} onKindChange={(next) => { setKind(next); if (next === 'agent' && (selectedProject === 'local' || selectedProject === 'direct')) setProject(''); }} />
    <div className="session-start-location">
      <Field label={copy.project} required>
        <Select value={selectedProject} disabled={Boolean(projectId) || locked || busy} onChange={(event) => { setProject(event.currentTarget.value); setWorkspace(''); setError(null); }} data-testid="new-session-project">
          <option value="">{copy.selectProject}</option>
          {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          {projectId && !projects.some((entry) => entry.id === projectId) && <option value={projectId}>{projectId}</option>}
          {kind === 'terminal' && <><option value="local">{copy.local}</option><option value="direct">{copy.direct}</option></>}
        </Select>
      </Field>
      {selectedProject === 'direct' ? <Field label={copy.folder} required><Input value={directory} disabled={busy || locked} onChange={(event) => setDirectory(event.currentTarget.value)} /></Field> : selectedProject !== 'local' && <Field label={copy.workspace} required>
        <Select value={selectedWorkspace} disabled={Boolean(workspaceId) || locked || busy || !selectedProject} onChange={(event) => { setWorkspace(event.currentTarget.value); setError(null); }} data-testid="new-session-workspace">
          <option value="">{copy.selectWorkspace}</option>
          {workspaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          {selectedWorkspace && !selected && <option value={selectedWorkspace}>{copy.stale}</option>}
        </Select>
      </Field>}
      {selected && <p title={selected.rootPath}>{selected.rootPath}</p>}
    </div>
    <div hidden={kind !== 'agent'}>
      {!agent.providers.some((entry) => !entry.disabled) && <p role="status">{copy.noProvider} </p>}
      {onSettings && !agent.providers.some((entry) => !entry.disabled) && <Button variant="ghost" disabled={locked || busy} onClick={onSettings}>{copy.setup}</Button>}
      <StructuredAgentDraftPanel {...agent} embedded hideWorkspaceField selectedWorkspaceId={selectedWorkspace} workspaces={agent.workspaces.filter((entry) => workspaces.some((workspace) => workspace.id === entry.id))} loading={agent.loading || busy} onBusyChange={setAgentBusy} />
    </div>
    {kind === 'terminal' && <div className="session-start-cli" data-testid="new-session-terminal-panel">
      <TerminalLaunchPanel access={access} workspaceId={selected?.id} directory={selectedProject === 'direct' ? directory.trim() : undefined} disabled={recovery || busy || !validLocation} locked={locked || busy} onLaunch={onLaunchCli} onSettings={onSettings} onBusyChange={setAgentBusy} terminalAction={<>
      <p>{copy.terminalHint}</p>
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" disabled={locked || !validLocation} loading={busy} onClick={() => void openTerminal()} data-testid="new-session-open-terminal">{copy.openTerminal}</Button>
      </>} />
    </div>}
  </section>;
}
