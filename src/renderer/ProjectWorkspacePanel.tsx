import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  GitBranch,
  GitCommitHorizontal,
  Map as MapIcon,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { AgentProjectSummary } from '../shared/agent-history';
import type {
  ProjectDocumentDirectoryEntry,
  ProjectSearchMatch,
  ProjectSessionTarget,
  ProjectWorkspaceDescriptor,
  ProjectWorkspaceLocationDescriptor,
} from '../shared/project-workspace';
import { FileSystemEntryIcon } from './FileSystemEntryIcon';
import { DeferredSearchInput } from './DeferredSearchInput';
import { formatCwd } from './format-cwd';
import { useAppTranslation } from './i18n';
import type { ProjectCodeLocation } from './project-code-navigation';
import type { ProjectEditorDocument } from './project-editor-model';
import { Button, Dialog, IconButton } from './ui';

export interface ProjectExplorerState {
  readonly expandedPaths: readonly string[];
  readonly selectedPath: string | null;
  readonly query: string;
  readonly searchMode: 'files' | 'content';
}

interface ProjectWorkspacePanelProps {
  readonly project: AgentProjectSummary;
  readonly onBack: () => void;
  readonly onOpenDocument: (
    document: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ) => void;
  readonly onNewSession: (target: ProjectSessionTarget, locationLabel: string) => void;
  readonly onOpenProjectMap?: (target: {
    readonly projectId: string;
    readonly rootId: string;
    readonly workspaceId: string;
  }) => void;
  readonly onManage: () => void;
  /** Optional controlled state seam for App-owned sidebar restoration. */
  readonly explorerState?: ProjectExplorerState;
  readonly onExplorerStateChange?: (state: ProjectExplorerState) => void;
}

interface LoadedDirectory {
  readonly loading: boolean;
  readonly loaded?: boolean;
  readonly error?: string;
  readonly warning?: string;
  readonly entries: readonly ProjectDocumentDirectoryEntry[];
}

interface DirectoryStore {
  readonly scopeKey: string;
  readonly directories: ReadonlyMap<string, LoadedDirectory>;
}

interface SearchViewState {
  readonly scopeKey: string;
  readonly matches: readonly ProjectSearchMatch[];
  readonly searching: boolean;
  readonly notice: string | null;
}

const LAST_WORKSPACE_PREFIX = 'ezterminal.project-workbench.workspace.';
const DEFAULT_EXPLORER_STATE: ProjectExplorerState = {
  expandedPaths: ['__root__'],
  selectedPath: null,
  query: '',
  searchMode: 'files',
};
const EMPTY_DIRECTORIES: ReadonlyMap<string, LoadedDirectory> = new Map();

function directoryKey(relativePath: string): string {
  return relativePath || '__root__';
}

function fallbackWorkspaces(
  descriptor: ProjectWorkspaceDescriptor,
): readonly ProjectWorkspaceLocationDescriptor[] {
  return descriptor.workspaces ?? descriptor.roots.map((root) => ({
    workspaceId: root.rootId,
    rootId: root.rootId,
    name: root.name,
    displayPath: root.displayPath,
    kind: 'root' as const,
    access: 'granted' as const,
  }));
}

function changeLabel(change: ProjectDocumentDirectoryEntry['status']): string {
  if (change === 'added') return 'A';
  if (change === 'deleted') return 'D';
  if (change === 'renamed') return 'R';
  return 'M';
}

function sameExplorerState(left: ProjectExplorerState, right: ProjectExplorerState): boolean {
  return left.selectedPath === right.selectedPath
    && left.query === right.query
    && left.searchMode === right.searchMode
    && left.expandedPaths.length === right.expandedPaths.length
    && left.expandedPaths.every((path, index) => path === right.expandedPaths[index]);
}

function ProjectCodeTree({
  descriptor,
  workspace,
  state,
  onStateChange,
  onOpen,
}: {
  readonly descriptor: ProjectWorkspaceDescriptor;
  readonly workspace: ProjectWorkspaceLocationDescriptor;
  readonly state: ProjectExplorerState;
  readonly onStateChange: (state: ProjectExplorerState) => void;
  readonly onOpen: (
    document: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const scopeKey = [descriptor.projectId, workspace.rootId, workspace.workspaceId].join('\0');
  const [directoryStore, setDirectoryStore] = useState<DirectoryStore>(() => ({
    scopeKey,
    directories: new Map(),
  }));
  const [searchView, setSearchView] = useState<SearchViewState>(() => ({
    scopeKey,
    matches: [],
    searching: false,
    notice: null,
  }));
  const directoriesRef = useRef<DirectoryStore>({ scopeKey, directories: new Map() });
  const stateRef = useRef(state);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchId = useRef('');
  const scopeKeyRef = useRef(scopeKey);
  const scopeGenerationRef = useRef(0);
  const directoryGenerationRef = useRef(0);
  const directoryRequestSerialRef = useRef(0);
  const activeDirectoryRequestsRef = useRef(new Map<string, number>());

  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    scopeGenerationRef.current += 1;
    directoryGenerationRef.current += 1;
    activeDirectoryRequestsRef.current.clear();
    directoriesRef.current = { scopeKey, directories: new Map() };
  }

  const directories = directoryStore.scopeKey === scopeKey
    ? directoryStore.directories
    : EMPTY_DIRECTORIES;
  const matches = searchView.scopeKey === scopeKey ? searchView.matches : [];
  const searching = searchView.scopeKey === scopeKey && searchView.searching;
  const notice = searchView.scopeKey === scopeKey ? searchView.notice : null;
  const expanded = useMemo(
    () => new Set(['__root__', ...state.expandedPaths]),
    [state.expandedPaths],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const updateState = useCallback((patch: Partial<ProjectExplorerState>): void => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    onStateChange(next);
  }, [onStateChange]);

  const loadDirectory = useCallback(async (
    relativePath: string,
    force = false,
    generation = directoryGenerationRef.current,
  ): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    const key = directoryKey(relativePath);
    const requestScopeKey = scopeKey;
    const scopeGeneration = scopeGenerationRef.current;
    if (generation !== directoryGenerationRef.current) return;
    const currentDirectories = directoriesRef.current.scopeKey === requestScopeKey
      ? directoriesRef.current.directories
      : EMPTY_DIRECTORIES;
    if (!force && currentDirectories.get(key)?.loading) return;
    const requestSerial = directoryRequestSerialRef.current + 1;
    directoryRequestSerialRef.current = requestSerial;
    activeDirectoryRequestsRef.current.set(key, requestSerial);
    const pendingDirectories = new Map(currentDirectories);
    pendingDirectories.set(key, {
      loading: true,
      loaded: currentDirectories.get(key)?.loaded,
      entries: currentDirectories.get(key)?.entries ?? [],
    });
    const pendingStore = { scopeKey: requestScopeKey, directories: pendingDirectories };
    directoriesRef.current = pendingStore;
    setDirectoryStore(pendingStore);
    const result = await desktop.listProjectDocumentDirectory({
      projectId: descriptor.projectId,
      rootId: workspace.rootId,
      workspaceId: workspace.workspaceId,
      relativePath,
    }).catch(() => null);
    if (scopeKeyRef.current !== requestScopeKey
      || scopeGenerationRef.current !== scopeGeneration
      || directoryGenerationRef.current !== generation
      || activeDirectoryRequestsRef.current.get(key) !== requestSerial) return;
    const latestDirectories = directoriesRef.current.scopeKey === requestScopeKey
      ? directoriesRef.current.directories
      : EMPTY_DIRECTORIES;
    const previousEntries = latestDirectories.get(key)?.entries ?? [];
    const hadSuccessfulResult = latestDirectories.get(key)?.loaded === true;
    const nextDirectory: LoadedDirectory = result?.ok
      ? {
          loading: false,
          loaded: true,
          entries: result.statusError && hadSuccessfulResult
            ? previousEntries
            : result.entries,
          ...(result.statusError ? { warning: result.statusError } : {}),
        }
      : {
          loading: false,
          loaded: hadSuccessfulResult,
          error: result?.error ?? 'io-error',
          entries: previousEntries,
        };
    const nextDirectories = new Map(latestDirectories);
    nextDirectories.set(key, nextDirectory);
    const nextStore = { scopeKey: requestScopeKey, directories: nextDirectories };
    directoriesRef.current = nextStore;
    setDirectoryStore(nextStore);
  }, [descriptor.projectId, scopeKey, workspace.rootId, workspace.workspaceId]);

  useEffect(() => {
    const nextStore = { scopeKey, directories: new Map<string, LoadedDirectory>() };
    directoriesRef.current = nextStore;
    setDirectoryStore(nextStore);
    activeDirectoryRequestsRef.current.clear();
    const generation = directoryGenerationRef.current;
    const paths = new Set(['__root__', ...stateRef.current.expandedPaths]);
    for (const path of paths) {
      void loadDirectory(path === '__root__' ? '' : path, true, generation);
    }
    return () => {
      if (scopeKeyRef.current === scopeKey) {
        scopeGenerationRef.current += 1;
        directoryGenerationRef.current += 1;
      }
    };
  }, [loadDirectory, scopeKey]);

  useEffect(() => {
    const generation = directoryGenerationRef.current;
    for (const path of new Set(['__root__', ...state.expandedPaths])) {
      const key = directoryKey(path === '__root__' ? '' : path);
      if (!directoriesRef.current.directories.has(key)) {
        void loadDirectory(path === '__root__' ? '' : path, false, generation);
      }
    }
  }, [loadDirectory, state.expandedPaths]);

  const toggle = (relativePath: string): void => {
    const key = directoryKey(relativePath);
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      if (!directoriesRef.current.directories.has(key)) void loadDirectory(relativePath);
    }
    updateState({ expandedPaths: [...next] });
  };

  const visibleEntries = useMemo(() => {
    const rows: Array<{ entry: ProjectDocumentDirectoryEntry; depth: number; parent: string }> = [];
    const visit = (relativePath: string, depth: number): void => {
      const key = directoryKey(relativePath);
      if (!expanded.has(key)) return;
      for (const entry of directories.get(key)?.entries ?? []) {
        rows.push({ entry, depth, parent: relativePath });
        if (entry.kind === 'directory') visit(entry.relativePath, depth + 1);
      }
    };
    visit('', 1);
    return rows;
  }, [directories, expanded]);
  const expandedDirectoryStates = [...expanded]
    .map((path) => directories.get(directoryKey(path === '__root__' ? '' : path)))
    .filter((directory): directory is LoadedDirectory => Boolean(directory));
  const directoryBusy = expandedDirectoryStates.some((directory) => directory.loading);
  const directoryError = expandedDirectoryStates.find((directory) => directory.error)?.error;
  const directoryWarning = expandedDirectoryStates.find((directory) => directory.warning)?.warning;

  const keyDown = (event: React.KeyboardEvent, index: number): void => {
    const row = visibleEntries[index];
    if (!row) return;
    const { entry } = row;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp'
      || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? visibleEntries.length - 1
          : Math.max(0, Math.min(
            visibleEntries.length - 1,
            index + (event.key === 'ArrowDown' ? 1 : -1),
          ));
      const next = visibleEntries[nextIndex]?.entry.relativePath;
      if (next) {
        updateState({ selectedPath: next });
        requestAnimationFrame(() => rowRefs.current.get(next)?.focus());
      }
      return;
    }
    if (event.key === 'ArrowRight' && entry.kind === 'directory') {
      event.preventDefault();
      if (!expanded.has(directoryKey(entry.relativePath))) toggle(entry.relativePath);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (entry.kind === 'directory' && expanded.has(directoryKey(entry.relativePath))) {
        toggle(entry.relativePath);
      } else if (row.parent) {
        updateState({ selectedPath: row.parent });
        requestAnimationFrame(() => rowRefs.current.get(row.parent)?.focus());
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (entry.kind === 'directory') toggle(entry.relativePath);
      else onOpen({ ...entry.document.id, documentKey: entry.document.key }, undefined);
    }
  };

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    const trimmed = state.query.trim();
    const requestScopeKey = scopeKey;
    const scopeGeneration = scopeGenerationRef.current;
    if (!desktop || !trimmed) {
      if (searchId.current) desktop?.cancelProjectWorkspaceSearch(searchId.current);
      searchId.current = '';
      setSearchView({
        scopeKey: requestScopeKey,
        matches: [],
        searching: false,
        notice: null,
      });
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (searchId.current) desktop.cancelProjectWorkspaceSearch(searchId.current);
      const requestId = `project-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      searchId.current = requestId;
      setSearchView({
        scopeKey: requestScopeKey,
        matches: [],
        searching: true,
        notice: null,
      });
      void desktop.searchProjectWorkspace({
        requestId,
        projectId: descriptor.projectId,
        rootId: workspace.rootId,
        workspaceId: workspace.workspaceId,
        query: trimmed,
        mode: state.searchMode,
      }).then((result) => {
        if (searchId.current !== requestId
          || scopeKeyRef.current !== requestScopeKey
          || scopeGenerationRef.current !== scopeGeneration) return;
        searchId.current = '';
        setSearchView({
          scopeKey: requestScopeKey,
          searching: false,
          matches: result.ok ? result.matches : [],
          notice: result.ok && result.truncated
            ? t('projectWorkbench.resultsLimited', { count: result.scannedFiles })
            : !result.ok
              ? t('projectWorkbench.searchUnavailable', { error: result.error })
              : null,
        });
      }).catch(() => {
        if (searchId.current !== requestId
          || scopeKeyRef.current !== requestScopeKey
          || scopeGenerationRef.current !== scopeGeneration) return;
        searchId.current = '';
        setSearchView({
          scopeKey: requestScopeKey,
          searching: false,
          matches: [],
          notice: t('projectWorkbench.searchFailed'),
        });
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (searchId.current) {
        desktop.cancelProjectWorkspaceSearch(searchId.current);
        searchId.current = '';
      }
    };
  }, [descriptor.projectId, scopeKey, state.query, state.searchMode, t, workspace.rootId, workspace.workspaceId]);

  return (
    <div className="project-code-view">
      <div className="project-view-tools">
        <label className="project-search-control">
          <Search aria-hidden="true" size={14} />
          <DeferredSearchInput
            type="text"
            value={state.query}
            onQueryChange={(query) => updateState({ query })}
            placeholder={state.searchMode === 'files'
              ? t('projectWorkbench.quickOpen')
              : t('projectWorkbench.contentSearch')}
            aria-label={state.searchMode === 'files'
              ? t('projectWorkbench.quickOpen')
              : t('projectWorkbench.contentSearch')}
          />
        </label>
        <select
          aria-label={t('projectWorkbench.searchMode')}
          value={state.searchMode}
          onChange={(event) => updateState({
            searchMode: event.currentTarget.value as ProjectExplorerState['searchMode'],
          })}
        >
          <option value="files">{t('projectWorkbench.files')}</option>
          <option value="content">{t('projectWorkbench.content')}</option>
        </select>
        <IconButton
          icon={ChevronsUp}
          aria-label={t('projectWorkbench.collapseAll')}
          onClick={() => updateState({ expandedPaths: ['__root__'] })}
        />
        <IconButton
          icon={RefreshCw}
          aria-label={t('projectWorkbench.refresh')}
          onClick={() => {
            directoryGenerationRef.current += 1;
            activeDirectoryRequestsRef.current.clear();
            const generation = directoryGenerationRef.current;
            for (const path of new Set(['__root__', ...stateRef.current.expandedPaths])) {
              void loadDirectory(path === '__root__' ? '' : path, true, generation);
            }
          }}
        />
      </div>
      {notice && <p className="project-view-notice" role="status">{notice}</p>}
      {!state.query.trim() && directoryWarning && (
        <p className="project-view-notice" role="status">{directoryWarning}</p>
      )}
      {state.query.trim() ? (
        <div className="project-search-results" role="listbox" aria-label={t('projectWorkbench.searchResults')}>
          {searching && <div className="project-tree__state">{t('projectWorkbench.searching')}</div>}
          {!searching && matches.length === 0 && (
            <div className="project-tree__state">{t('projectWorkbench.noMatches')}</div>
          )}
          {matches.map((match) => (
              <button
                type="button"
                role="option"
                aria-selected={state.selectedPath === match.relativePath}
                key={`${match.rootId}:${match.relativePath}:${String(match.line ?? 0)}:${String(match.column ?? 0)}`}
                onFocus={() => updateState({ selectedPath: match.relativePath })}
                onClick={() => onOpen(
                  {
                    projectId: descriptor.projectId,
                    rootId: match.rootId,
                    workspaceId: workspace.workspaceId,
                    relativePath: match.relativePath,
                  },
                  match.line
                    ? { line: match.line, ...(match.column ? { column: match.column } : {}) }
                    : undefined,
                )}
              >
                <span className="project-search-result__path">
                  <FileSystemEntryIcon
                    name={match.relativePath}
                    kind="file"
                    size={15}
                    className="project-search-result__icon"
                  />
                  <span>{match.relativePath}{match.line ? `:${String(match.line)}` : ''}</span>
                </span>
                {match.preview && <small>{match.preview}</small>}
              </button>
          ))}
        </div>
      ) : (
        <>
          {directoryBusy && (
            <div className="project-tree__state" role="status">
              {t('projectWorkbench.loading')}
            </div>
          )}
          {directoryError && (
            <div className="project-tree__state project-tree__state--error" role="alert">
              {directoryError}
            </div>
          )}
          <div
            className="project-path-tree"
            role="tree"
            aria-label={t('projectWorkbench.codeTree')}
            aria-busy={directoryBusy || undefined}
          >
            {visibleEntries.map(({ entry, depth }, index) => {
              const isExpanded = entry.kind === 'directory'
                && expanded.has(directoryKey(entry.relativePath));
              const change = entry.kind === 'file' ? entry.status : undefined;
              return (
                <button
                  type="button"
                  className="project-tree__row"
                  role="treeitem"
                  aria-level={depth}
                  aria-expanded={entry.kind === 'directory' ? isExpanded : undefined}
                  aria-selected={state.selectedPath === entry.relativePath}
                  data-entry-kind={entry.kind}
                  data-expanded={entry.kind === 'directory' ? String(isExpanded) : undefined}
                  tabIndex={state.selectedPath === entry.relativePath
                    || (!state.selectedPath && index === 0) ? 0 : -1}
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.relativePath, element);
                    else rowRefs.current.delete(entry.relativePath);
                  }}
                  key={entry.relativePath}
                  style={{
                    paddingInlineStart: `${String(8 + (depth - 1) * 16)}px`,
                    '--project-tree-depth': Math.max(0, depth - 1),
                  } as CSSProperties}
                  onFocus={() => updateState({ selectedPath: entry.relativePath })}
                  onClick={() => {
                    updateState({ selectedPath: entry.relativePath });
                    if (entry.kind === 'directory') toggle(entry.relativePath);
                    else onOpen(
                      { ...entry.document.id, documentKey: entry.document.key },
                      undefined,
                    );
                  }}
                  onKeyDown={(event) => keyDown(event, index)}
                >
                  {entry.kind === 'directory'
                    ? isExpanded
                      ? <ChevronDown aria-hidden="true" size={14} />
                      : <ChevronRight aria-hidden="true" size={14} />
                    : <span className="project-tree__spacer" />}
                  <FileSystemEntryIcon
                    name={entry.name}
                    kind={entry.kind === 'directory' ? 'directory' : 'file'}
                    expanded={isExpanded}
                    size={15}
                    className="project-tree__entry-icon"
                  />
                  <span className="project-tree__name">{entry.name}</span>
                  {change && (
                    <b className="project-file-change" data-kind={change}>{changeLabel(change)}</b>
                  )}
                  {change && entry.additions !== undefined && entry.deletions !== undefined && (
                    <small className="project-file-change-count">
                      +{entry.additions} −{entry.deletions}
                    </small>
                  )}
                  {entry.previousRelativePath && (
                    <small className="project-file-previous" title={entry.previousRelativePath}>
                      ← {entry.previousRelativePath}
                    </small>
                  )}
                  {entry.renamedToRelativePath && (
                    <small className="project-file-previous" title={entry.renamedToRelativePath}>
                      → {entry.renamedToRelativePath}
                    </small>
                  )}
                  {entry.sensitive && <small>{t('projectWorkbench.sensitiveWarning')}</small>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function ProjectWorkspacePanel({
  project,
  onBack,
  onOpenDocument,
  onNewSession,
  onOpenProjectMap,
  onManage,
  explorerState,
  onExplorerStateChange,
}: ProjectWorkspacePanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const [descriptor, setDescriptor] = useState<ProjectWorkspaceDescriptor | null>(null);
  const [descriptorError, setDescriptorError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() =>
    localStorage.getItem(`${LAST_WORKSPACE_PREFIX}${project.projectId}`) ?? '');
  const [internalExplorerState, setInternalExplorerState] = useState(DEFAULT_EXPLORER_STATE);
  const [approvalTarget, setApprovalTarget] = useState<ProjectWorkspaceLocationDescriptor | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const activeExplorerState = explorerState ?? internalExplorerState;

  const updateExplorerState = useCallback((next: ProjectExplorerState): void => {
    if (!explorerState) setInternalExplorerState(next);
    if (!sameExplorerState(activeExplorerState, next)) onExplorerStateChange?.(next);
  }, [activeExplorerState, explorerState, onExplorerStateChange]);

  const loadDescriptor = useCallback(async (): Promise<void> => {
    const result = await window.ezterminalDesktop?.describeProjectWorkspace(project.projectId).catch(() => null);
    if (!result?.ok) {
      setDescriptor(null);
      setDescriptorError(result?.error ?? 'io-error');
      return;
    }
    setDescriptor(result.project);
    setDescriptorError(null);
    const workspaces = fallbackWorkspaces(result.project);
    setSelectedWorkspaceId((current) => {
      const selected = workspaces.some((workspace) => workspace.workspaceId === current)
        ? current
        : workspaces.find((workspace) => workspace.kind === 'main')?.workspaceId
          ?? workspaces[0]?.workspaceId
          ?? '';
      if (selected) localStorage.setItem(`${LAST_WORKSPACE_PREFIX}${project.projectId}`, selected);
      return selected;
    });
  }, [project.projectId]);

  useEffect(() => {
    void loadDescriptor();
  }, [loadDescriptor]);

  const workspaces = useMemo(() => descriptor ? fallbackWorkspaces(descriptor) : [], [descriptor]);
  const workspace = workspaces.find((candidate) => candidate.workspaceId === selectedWorkspaceId)
    ?? workspaces[0];
  const selectedRoot = descriptor?.roots.find((root) => root.rootId === workspace?.rootId);

  useEffect(() => {
    if (!workspace?.workspaceId) return;
    localStorage.setItem(`${LAST_WORKSPACE_PREFIX}${project.projectId}`, workspace.workspaceId);
    setInternalExplorerState(DEFAULT_EXPLORER_STATE);
  }, [project.projectId, workspace?.workspaceId]);

  const approveWorkspace = async (): Promise<void> => {
    if (!approvalTarget || !descriptor || !window.ezterminalDesktop) return;
    setApprovalBusy(true);
    setApprovalError(null);
    const result = await window.ezterminalDesktop.approveProjectWorkspace({
      projectId: descriptor.projectId,
      rootId: approvalTarget.rootId,
      workspaceId: approvalTarget.workspaceId,
    }).catch(() => null);
    setApprovalBusy(false);
    if (!result?.ok) {
      setApprovalError(result?.error ?? 'io-error');
      return;
    }
    setApprovalTarget(null);
    await loadDescriptor();
  };

  if (!descriptor) {
    return (
      <section className="project-workspace" data-testid="project-workspace-panel">
        <header className="project-workspace__header">
          <IconButton
            icon={ArrowLeft}
            aria-label={t('projectWorkbench.backToProjects')}
            onClick={onBack}
          />
          <div>
            <strong>{project.name}</strong>
            <small>{formatCwd(project.primaryRoot)}</small>
          </div>
        </header>
        <div className="project-workspace__empty" role={descriptorError ? 'alert' : 'status'}>
          {descriptorError
            ? t('projectWorkbench.projectUnavailable', { error: descriptorError })
            : t('projectWorkbench.loading')}
        </div>
      </section>
    );
  }

  return (
    <section className="project-workspace" data-testid="project-workspace-panel">
      <header className="project-workspace__header">
        <IconButton
          icon={ArrowLeft}
          aria-label={t('projectWorkbench.backToProjects')}
          onClick={onBack}
          data-testid="project-workspace-back"
        />
        <div className="project-workspace__identity">
          <strong>{project.name}</strong>
          <small title={workspace?.displayPath ?? selectedRoot?.displayPath}>
            {formatCwd(workspace?.displayPath ?? selectedRoot?.displayPath ?? project.primaryRoot)}
          </small>
        </div>
        <IconButton
          icon={MessageSquarePlus}
          aria-label={t('agentHub.projects.newSession')}
          disabled={!workspace || workspace.access !== 'granted'}
          onClick={() => {
            if (!workspace || workspace.access !== 'granted') return;
            onNewSession({
              projectId: project.projectId,
              rootId: workspace.rootId,
              workspaceId: workspace.workspaceId,
            }, workspace.displayPath);
          }}
          data-testid="project-workspace-new-session"
        />
        <IconButton
          icon={MapIcon}
          aria-label={t('projectMap.open', 'Open Project Map')}
          disabled={!workspace || workspace.access !== 'granted' || !onOpenProjectMap}
          onClick={() => {
            if (!workspace || workspace.access !== 'granted') return;
            onOpenProjectMap?.({
              projectId: project.projectId,
              rootId: workspace.rootId,
              workspaceId: workspace.workspaceId,
            });
          }}
          data-testid="project-workspace-open-map"
        />
        <IconButton
          icon={Settings}
          aria-label={t('agentHub.projects.manage', { name: project.name })}
          onClick={onManage}
        />
      </header>
      {(workspaces.length > 1 || (workspace?.kind === 'external' && workspace.access === 'granted')) && (
        <div className="project-workspace__selector">
          {workspaces.length > 1 && (
            <>
              <label htmlFor="project-workspace-select">{t('projectWorkbench.workLocation')}</label>
              <select
                id="project-workspace-select"
                value={workspace?.workspaceId ?? ''}
                onChange={(event) => {
                  const next = workspaces.find(
                    (candidate) => candidate.workspaceId === event.currentTarget.value,
                  );
                  setSelectedWorkspaceId(event.currentTarget.value);
                  if (next?.access === 'authorization-required') setApprovalTarget(next);
                }}
              >
                {descriptor.roots.map((root) => (
                  <optgroup key={root.rootId} label={root.name}>
                    {workspaces.filter((candidate) => candidate.rootId === root.rootId)
                      .map((candidate) => (
                        <option key={candidate.workspaceId} value={candidate.workspaceId}>
                          {candidate.branch || candidate.name}
                          {candidate.access === 'authorization-required'
                            ? ` · ${t('projectWorkbench.approvalRequired')}`
                            : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </>
          )}
          {workspace?.kind === 'external' && workspace.access === 'granted' && (
            <button
              type="button"
              className="project-workspace__revoke"
              onClick={() => {
                void window.ezterminalDesktop?.revokeProjectWorkspace({
                  projectId: descriptor.projectId,
                  rootId: workspace.rootId,
                  workspaceId: workspace.workspaceId,
                }).then(() => loadDescriptor());
              }}
            >
              {t('projectWorkbench.revokeAccess')}
            </button>
          )}
        </div>
      )}
      <div className="project-workspace__content">
        {!workspace || workspace.access !== 'granted' ? (
          <div className="project-workspace__authorization">
            <ShieldCheck aria-hidden="true" />
            <strong>{t('projectWorkbench.externalWorktree')}</strong>
            <p>{t('projectWorkbench.externalWorktreeDescription')}</p>
            {workspace && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setApprovalTarget(workspace)}
              >
                {t('projectWorkbench.reviewAccess')}
              </Button>
            )}
          </div>
        ) : (
          <ProjectCodeTree
              descriptor={descriptor}
              workspace={workspace}
              state={activeExplorerState}
              onStateChange={updateExplorerState}
              onOpen={onOpenDocument}
            />
        )}
      </div>
      <Dialog
        open={approvalTarget !== null}
        onOpenChange={(open) => {
          if (!open && !approvalBusy) setApprovalTarget(null);
        }}
        title={t('projectWorkbench.approveExternalTitle')}
        description={t('projectWorkbench.approveExternalDescription')}
        closeLabel={t('common.cancel')}
        testId="project-workspace-approval"
        footer={(
          <>
            <Button
              variant="ghost"
              onClick={() => setApprovalTarget(null)}
              disabled={approvalBusy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void approveWorkspace()}
              loading={approvalBusy}
            >
              {t('projectWorkbench.approveAccess')}
            </Button>
          </>
        )}
      >
        <div className="project-workspace-approval__identity">
          <GitBranch aria-hidden="true" />
          <strong>{approvalTarget?.branch || approvalTarget?.name}</strong>
          <code>{approvalTarget?.displayPath}</code>
          {approvalTarget?.head && (
            <small>
              <GitCommitHorizontal aria-hidden="true" /> {approvalTarget.head.slice(0, 12)}
            </small>
          )}
        </div>
        {approvalError && (
          <p className="project-view-notice project-view-notice--error" role="alert">
            {approvalError}
          </p>
        )}
      </Dialog>
    </section>
  );
}
