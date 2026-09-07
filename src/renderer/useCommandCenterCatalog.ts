import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DockviewApi } from 'dockview-react';

import { type AgentStatus, type AgentIntegrationStatus, type GenericAgentProfile } from '../shared/agent';

import type { SessionInfo } from '../shared/ipc';

import { type QuickCommand, type QuickCommandInput, type QuickCommandMutationResult } from '../shared/quick-command';

import { WORKSPACE_FILE_SEARCH_DEBOUNCE_MS } from '../shared/workspace-search';

import { subsequenceMatch } from './fuzzy';

import {
  type QuickCommandManageResult,
  type QuickCommandManagerConfig,
  type QuickOpenMode,
  type QuickOpenRow,
} from './QuickOpenModal';

import { type RecentPanelSwitcherItem } from './RecentPanelSwitcher';

import { rendererCapabilities } from './capability-access';

import { getActiveAppDocument } from './desktop-window-registry';

import { buildCommandCenterActionRows, type QuickOpenBuiltinAction } from './command-center-actions';

import { listPaneSnapshots, subscribePaneRegistry } from './pane-registry';

import { type RecentPanelSwitchSession } from './recent-panel-switching';

import type { TFunction } from 'i18next';
import type { MutableRefObject } from 'react';

type QuickOpenTarget =
  | { readonly type: 'pane'; readonly panelId: string; }
  | { readonly type: 'file'; readonly path: string; }
  | { readonly type: 'command'; readonly command: string; }
  | { readonly type: 'action'; readonly action: QuickOpenBuiltinAction; }
  | { readonly type: 'preset'; readonly name: string; }
  | { readonly type: 'background-session'; readonly sessionId: string; };

export type AppQuickOpenRow = QuickOpenRow & { readonly target: QuickOpenTarget; };

interface AgentLauncher {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly detail: string;
  readonly sourceLabel: string;
}

function recentDistinctCommands(history: readonly string[]): string[] {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const command = history[index] ?? '';
    const key = command.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recent.push(command);
  }
  return recent;
}

function workspaceFilePath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, '');
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

interface UseCommandCenterCatalogOptions {
  readonly activePanelId: string | null;
  readonly recentPanelSwitch: RecentPanelSwitchSession | null;
  readonly apiRef: MutableRefObject<DockviewApi | null>;
  readonly t: TFunction<"translation", undefined>;
  readonly agentTabStatuses: ReadonlyMap<string, { readonly status: AgentStatus; }>;
  readonly crashInfo: { logPath: string | null; recovered: boolean; } | null;
  readonly quickPreviewSequenceRef: MutableRefObject<number>;
  readonly setQuickPreview: (preview: null) => void;
  readonly refreshPresets: () => Promise<void>;
  readonly quickCommandManageResult: (result: QuickCommandMutationResult) => QuickCommandManageResult;
  readonly openclawVisible: boolean;
  readonly presetNames: string[];
}

export function useCommandCenterCatalog({

  activePanelId,

  recentPanelSwitch,

  apiRef,

  t,

  agentTabStatuses,

  crashInfo,

  quickPreviewSequenceRef,

  setQuickPreview,

  refreshPresets,

  quickCommandManageResult,

  openclawVisible,

  presetNames,

}: UseCommandCenterCatalogOptions) {
  const [quickOpenMode, setQuickOpenMode] = useState<QuickOpenMode | null>(null);
  const [quickOpenOwnerDocument, setQuickOpenOwnerDocument] = useState<Document>(() => document);
  const [quickOpenQuery, setQuickOpenQuery] = useState('');
  const [quickOpenActionMessage, setQuickOpenActionMessage] = useState<string | null>(null);
  const [quickCommands, setQuickCommands] = useState<readonly QuickCommand[]>([]);
  const [fileSearchRows, setFileSearchRows] = useState<readonly AppQuickOpenRow[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchMessage, setFileSearchMessage] = useState<string | null>(null);
  const fileSearchSequenceRef = useRef(0);
  const [, bumpPaneRegistryRevision] = useState(0);
  const [agentIntegrations, setAgentIntegrations] = useState<readonly AgentIntegrationStatus[]>([]);
  const [genericAgentProfiles, setGenericAgentProfiles] = useState<readonly GenericAgentProfile[]>([]);

  useEffect(() => subscribePaneRegistry(() => bumpPaneRegistryRevision((revision) => revision + 1)), []);

  const paneSnapshots = listPaneSnapshots();
  const activePaneSnapshot = paneSnapshots.find((pane) => pane.panelId === activePanelId) ?? null;
  const activeWorkspaceRoot = activePaneSnapshot?.cwd.trim() ?? '';
  const recentPanelItems = useMemo<readonly RecentPanelSwitcherItem[]>(() => {
    if (!recentPanelSwitch) return [];
    const snapshots = new Map(paneSnapshots.map((pane) => [pane.panelId, pane] as const));
    return recentPanelSwitch.panelIds.flatMap((panelId) => {
      const panel = apiRef.current?.getPanel(panelId);
      if (!panel) return [];
      const snapshot = snapshots.get(panelId);
      const statuses: string[] = [];
      if (panelId === recentPanelSwitch.originPanelId) statuses.push(t('recentPanels.statuses.current'));
      if (snapshot?.sessionBindingPending) statuses.push(t('recentPanels.statuses.connecting'));
      if (snapshot?.isBusy) statuses.push(t('recentPanels.statuses.busy'));
      if (snapshot?.draft.trim()) statuses.push(t('recentPanels.statuses.draft'));
      if (snapshot?.hasSshPrompt) statuses.push(t('recentPanels.statuses.sshPrompt'));
      if (snapshot?.isDead) statuses.push(t('recentPanels.statuses.ended'));
      const agentStatus = agentTabStatuses.get(panelId)?.status;
      if (agentStatus && agentStatus !== 'done') {
        statuses.push(t('recentPanels.agentStatus', { status: t(`agentHub.status.${agentStatus}`) }));
      }
      if (crashInfo && panel.api.component === 'terminal') {
        statuses.push(t('recentPanels.statuses.interpreterUnavailable'));
      }
      return [
        {
          panelId,
          title:
            panel.api.title?.trim()
            || (panel.api.component === 'terminal'
              ? t('recentPanels.terminal')
              : t('recentPanels.workspacePanel')),
          detail:
            snapshot?.cwd.trim() ||
            (panel.api.component === 'terminal'
              ? t('recentPanels.workingDirectoryUnavailable')
              : t('recentPanels.workspacePanel')),
          statuses,
        },
      ];
    });
  }, [agentTabStatuses, apiRef, crashInfo, paneSnapshots, recentPanelSwitch, t]);

  const closeQuickOpen = useCallback((): void => {
    setQuickOpenMode(null);
    setQuickOpenQuery('');
    setQuickOpenActionMessage(null);
    setFileSearchMessage(null);
  }, []);

  const refreshAgentLaunchers = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await rendererCapabilities.agentIntegrations.load();
      if (!snapshot) return;
      setAgentIntegrations(snapshot.integrations);
      setGenericAgentProfiles(snapshot.settings.genericProfiles);
    } catch {
      // Launcher discovery is optional; the existing launcher list remains usable.
    }
  }, []);

  useEffect(() => {
    void refreshAgentLaunchers();
  }, [refreshAgentLaunchers]);

  const openQuickOpen = useCallback(
    (mode: QuickOpenMode, ownerDocument: Document = getActiveAppDocument()): void => {
      quickPreviewSequenceRef.current += 1;
      setQuickPreview(null);
      setQuickOpenOwnerDocument(ownerDocument);
      setQuickOpenMode(mode);
      setQuickOpenQuery('');
      setQuickOpenActionMessage(null);
      setFileSearchMessage(null);
      void refreshPresets();
      void refreshAgentLaunchers();
    },
    [quickPreviewSequenceRef, refreshAgentLaunchers, refreshPresets, setQuickPreview],
  );

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || typeof desktop.listQuickCommands !== 'function') return;
    let alive = true;
    let receivedPush = false;
    const unsubscribe =
      typeof desktop.onQuickCommandsChanged === 'function'
        ? desktop.onQuickCommandsChanged((commands) => {
          receivedPush = true;
          if (alive) setQuickCommands(commands);
        })
        : undefined;
    void desktop
      .listQuickCommands()
      .then((commands) => {
        if (alive && !receivedPush) setQuickCommands(commands);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const upsertQuickCommand = useCallback((command: QuickCommand): void => {
    setQuickCommands((current) => [command, ...current.filter((candidate) => candidate.id !== command.id)]);
  }, []);

  const createQuickCommand = useCallback(
    async (input: QuickCommandInput): Promise<QuickCommandManageResult> => {
      const desktop = window.ezterminalDesktop;
      if (!desktop || typeof desktop.createQuickCommand !== 'function') {
        return { ok: false, message: t('quickCommands.unavailable') };
      }
      const result = await desktop.createQuickCommand(input);
      if (result.ok) upsertQuickCommand(result.command);
      return quickCommandManageResult(result);
    },
    [quickCommandManageResult, t, upsertQuickCommand],
  );

  const updateQuickCommand = useCallback(
    async (id: string, input: QuickCommandInput): Promise<QuickCommandManageResult> => {
      const desktop = window.ezterminalDesktop;
      if (!desktop || typeof desktop.updateQuickCommand !== 'function') {
        return { ok: false, message: t('quickCommands.unavailable') };
      }
      const result = await desktop.updateQuickCommand(id, input);
      if (result.ok) upsertQuickCommand(result.command);
      return quickCommandManageResult(result);
    },
    [quickCommandManageResult, t, upsertQuickCommand],
  );

  const deleteQuickCommand = useCallback(
    async (id: string): Promise<QuickCommandManageResult> => {
      const desktop = window.ezterminalDesktop;
      if (!desktop || typeof desktop.deleteQuickCommand !== 'function') {
        return { ok: false, message: t('quickCommands.unavailable') };
      }
      const result = await desktop.deleteQuickCommand(id);
      if (result.ok) setQuickCommands((current) => current.filter((command) => command.id !== id));
      return quickCommandManageResult(result);
    },
    [quickCommandManageResult, t],
  );

  const desktopCapabilityAvailable =
    rendererCapabilities.snapshot().desktop === 'available';
  const quickCommandManager = useMemo<QuickCommandManagerConfig | undefined>(
    () =>
      desktopCapabilityAvailable
        ? {
          commands: quickCommands,
          onCreate: createQuickCommand,
          onUpdate: updateQuickCommand,
          onDelete: deleteQuickCommand,
        }
        : undefined,
    [
      createQuickCommand,
      deleteQuickCommand,
      desktopCapabilityAvailable,
      quickCommands,
      updateQuickCommand,
    ],
  );

  const runAvailabilityNote = activePaneSnapshot?.isBusy
    ? t('commandCenter.runUnavailableBusy')
    : activePaneSnapshot?.draft.trim()
      ? t('commandCenter.runUnavailableDraft')
      : null;
  const insertDisabledReason = !activePaneSnapshot
    ? t('commandCenter.selectPaneFirst')
    : activePaneSnapshot.isDead
      ? t('commandCenter.paneFailure.dead')
      : undefined;

  // Sessions that outlived their pane. "Keep running" would otherwise strand a
  // PTY with no route back: the mirror only reacts to add/remove events, so
  // nothing re-surfaces a session whose pane simply went away.
  const [backgroundSessions, setBackgroundSessions] = useState<readonly SessionInfo[]>([]);
  useEffect(() => {
    if (quickOpenMode === null) return;
    let alive = true;
    void window.ezterminal.listSessions().then((sessions) => {
      if (alive) setBackgroundSessions(sessions);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [quickOpenMode]);

  // Filtered at render against the current panes rather than inside the fetch
  // callback. "No pane is showing this session" is the definition, and pane
  // teardown is asynchronous: resolving the list first would race the removal
  // and hide a session that had in fact just been left running.
  const backgroundSessionRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    const shown = new Set(
      paneSnapshots.map((pane) => pane.sessionId).filter((id): id is string => id !== null),
    );
    return backgroundSessions
      .filter((session) => !shown.has(session.sessionId))
      .map((session) => ({
        id: session.sessionId,
        kind: 'background-session',
        title: session.cwd || t('commandCenter.cwdUnavailable'),
        detail: t('commandCenter.reclaimSession'),
        target: { type: 'background-session', sessionId: session.sessionId },
      }));
  }, [backgroundSessions, paneSnapshots, t]);

  const paneRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      paneSnapshots.map((pane) => {
        const state: string[] = [];
        if (pane.panelId === activePanelId) state.push(t('commandCenter.paneState.active'));
        if (pane.isBusy) state.push(t('commandCenter.paneState.busy'));
        if (pane.draft.trim()) state.push(t('commandCenter.paneState.draft'));
        if (pane.isDead) state.push(t('commandCenter.paneState.ended'));
        return {
          id: pane.panelId,
          kind: 'pane',
          title: apiRef.current?.getPanel(pane.panelId)?.api.title ?? t('mobile.terminal'),
          detail: [pane.cwd || t('commandCenter.cwdUnavailable'), ...state].join(' · '),
          target: { type: 'pane', panelId: pane.panelId },
        };
      }),
    [activePanelId, apiRef, paneSnapshots, t],
  );

  const historyRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    if (!activePaneSnapshot) return [];
    return recentDistinctCommands(activePaneSnapshot.history).map((command, index) => ({
      id: `${activePaneSnapshot.panelId}-${index}`,
      kind: 'history',
      title: command,
      detail: [t('commandCenter.activePaneHistory'), runAvailabilityNote].filter(Boolean).join(' · '),
      disabledReason: insertDisabledReason,
      target: { type: 'command', command },
    }));
  }, [activePaneSnapshot, insertDisabledReason, runAvailabilityNote, t]);

  const sortedQuickCommands = useMemo(
    () => [...quickCommands].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [quickCommands],
  );
  const quickCommandRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      sortedQuickCommands.map((command) => ({
        id: command.id,
        kind: 'quick-command',
        title: command.name,
        detail: [command.description, command.command, runAvailabilityNote].filter(Boolean).join(' · '),
        disabledReason: insertDisabledReason,
        target: { type: 'command', command: command.command },
      })),
    [insertDisabledReason, runAvailabilityNote, sortedQuickCommands],
  );

  const actionRows = useMemo<readonly AppQuickOpenRow[]>(
    () => buildCommandCenterActionRows(t, openclawVisible),
    [openclawVisible, t],
  );

  const presetRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      presetNames.map((name) => ({
        id: name,
        kind: 'preset',
        title: name,
        detail: t('commandCenter.applyPreset'),
        target: { type: 'preset', name },
      })),
    [presetNames, t],
  );

  const agentLaunchers = useMemo<readonly AgentLauncher[]>(() => {
    const integrationDetail = (provider: 'codex' | 'claude'): string => {
      const integration = agentIntegrations.find((candidate) => candidate.provider === provider);
      if (!integration) return t('commandCenter.agents.launchInPane');
      if (integration.enabled) return t('commandCenter.agents.hookEnabled');
      if (integration.blockers.length > 0) {
        return t('commandCenter.agents.hookUnavailable', {
          reason: integration.blockers[0],
        });
      }
      return t('commandCenter.agents.hookDisabled');
    };
    return [
      {
        id: 'codex',
        title: t('commandCenter.agents.launchNamed', { name: 'Codex' }),
        command: 'codex',
        detail: integrationDetail('codex'),
        sourceLabel: 'Codex',
      },
      {
        id: 'claude',
        title: t('commandCenter.agents.launchNamed', { name: 'Claude' }),
        command: 'claude',
        detail: integrationDetail('claude'),
        sourceLabel: 'Claude',
      },
      ...genericAgentProfiles
        .filter((profile) => profile.enabled && profile.executable.trim())
        .map((profile) => ({
          id: `generic-${profile.id}`,
          title: t('commandCenter.agents.launchNamed', { name: profile.name }),
          command: profile.executable,
          detail: t('commandCenter.agents.genericDetail', {
            executable: profile.executable,
          }),
          sourceLabel: t('commandCenter.kinds.agent'),
        })),
    ];
  }, [agentIntegrations, genericAgentProfiles, t]);

  const agentRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      agentLaunchers.map((agent) => ({
        id: agent.id,
        kind: 'agent',
        title: agent.title,
        detail: [agent.detail, runAvailabilityNote].filter(Boolean).join(' · '),
        sourceLabel: agent.sourceLabel,
        disabledReason: insertDisabledReason,
        target: { type: 'command', command: agent.command },
      })),
    [agentLaunchers, insertDisabledReason, runAvailabilityNote],
  );

  useEffect(() => {
    setFileSearchRows([]);
    setFileSearchMessage(null);
    setFileSearchLoading(false);
    const query = quickOpenQuery.trim();
    const desktop = window.ezterminalDesktop;
    if (
      quickOpenMode !== 'all' ||
      !query ||
      !activeWorkspaceRoot ||
      !desktop ||
      typeof desktop.searchWorkspaceFiles !== 'function'
    ) {
      return;
    }

    let cancelled = false;
    let requestId: string | null = null;
    setFileSearchLoading(true);
    const timer = setTimeout(() => {
      fileSearchSequenceRef.current += 1;
      requestId = `quick-open-${Date.now()}-${fileSearchSequenceRef.current}`;
      void desktop
        .searchWorkspaceFiles({ requestId, root: activeWorkspaceRoot, query })
        .then((result) => {
          if (cancelled || result.requestId !== requestId) return;
          setFileSearchLoading(false);
          if (!result.ok) {
            if (result.error !== 'cancelled') setFileSearchMessage(result.message);
            return;
          }
          setFileSearchRows(
            result.matches.map((match) => ({
              id: match.relativePath,
              kind: 'file',
              title: match.basename,
              detail: match.relativePath,
              target: {
                type: 'file',
                path: workspaceFilePath(result.root, match.relativePath),
              },
            })),
          );
        })
        .catch(() => {
          if (!cancelled) {
            setFileSearchLoading(false);
            setFileSearchMessage(t('commandCenter.workspaceSearchFailed'));
          }
        });
    }, WORKSPACE_FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (requestId && typeof desktop.cancelWorkspaceFileSearch === 'function') {
        desktop.cancelWorkspaceFileSearch(requestId);
      }
    };
  }, [activeWorkspaceRoot, quickOpenMode, quickOpenQuery, t]);

  const localQuickOpenRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      quickOpenMode === 'all'
        ? [
          ...paneRows,
          ...backgroundSessionRows,
          ...historyRows,
          ...quickCommandRows,
          ...actionRows,
          ...presetRows,
          ...agentRows,
        ]
        : [...historyRows, ...quickCommandRows, ...actionRows, ...presetRows, ...agentRows],
    [
      actionRows,
      agentRows,
      backgroundSessionRows,
      historyRows,
      paneRows,
      presetRows,
      quickCommandRows,
      quickOpenMode,
    ],
  );

  const quickOpenRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    const query = quickOpenQuery.trim();
    if (!query) return [];
    const localMatches = localQuickOpenRows.filter(
      (row) => subsequenceMatch(row.title, query) || Boolean(row.detail && subsequenceMatch(row.detail, query)),
    );
    return quickOpenMode === 'all' ? [...localMatches, ...fileSearchRows] : localMatches;
  }, [fileSearchRows, localQuickOpenRows, quickOpenMode, quickOpenQuery]);

  const quickOpenEmptyRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    const recentHistory = historyRows.slice(0, 5).map((row) => ({
      ...row,
      groupLabel: t('commandCenter.groups.recentHistory'),
    }));
    const recentQuick = quickCommandRows.slice(0, 5).map((row) => ({
      ...row,
      groupLabel: t('commandCenter.groups.recentQuickCommands'),
    }));
    // Backgrounded sessions belong in the empty state, not behind a guessed
    // search term: something still running with no pane should be the first
    // thing the Command Center offers, not something you have to look for.
    return quickOpenMode === 'all'
      ? [
        ...paneRows,
        ...backgroundSessionRows,
        ...recentHistory,
        ...recentQuick,
        ...actionRows,
        ...presetRows,
        ...agentRows,
      ]
      : [...recentHistory, ...recentQuick, ...actionRows, ...presetRows, ...agentRows];
  }, [
    actionRows,
    agentRows,
    backgroundSessionRows,
    historyRows,
    paneRows,
    presetRows,
    quickCommandRows,
    quickOpenMode,
    t,
  ]);

  return {
    setQuickOpenActionMessage,
    closeQuickOpen,
    quickOpenMode,
    openQuickOpen,
    quickCommands,
    recentPanelItems,
    quickOpenOwnerDocument,
    quickOpenQuery,
    setQuickOpenQuery,
    quickOpenRows,
    quickOpenEmptyRows,
    fileSearchLoading,
    quickOpenActionMessage,
    fileSearchMessage,
    quickCommandManager,
  };
}
