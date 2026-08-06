import { ChevronDown, ChevronRight, File, Folder, GitCompare, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentProjectSummary } from '../shared/agent-history';
import type {
  ProjectDirectoryEntry,
  ProjectRootDescriptor,
  ProjectSearchMatch,
  ProjectWorkspaceDescriptor,
} from '../shared/project-workspace';
import { useAppTranslation } from './i18n';
import type { ProjectCodeLocation } from './project-code-navigation';

const SELECTED_PROJECT_KEY = 'ezterminal.project-workbench.selected-project';

interface ProjectExplorerPanelProps {
  readonly onOpenFile: (
    projectId: string,
    rootId: string,
    relativePath: string,
    location?: ProjectCodeLocation,
  ) => void;
  readonly onOpenReview: (projectId: string, rootId: string) => void;
}

interface LoadedDirectory {
  readonly loading: boolean;
  readonly error?: string;
  readonly entries: readonly ProjectDirectoryEntry[];
}

function directoryKey(rootId: string, relativePath: string): string {
  return `${rootId}\0${relativePath}`;
}

export function ProjectExplorerPanel({
  onOpenFile,
  onOpenReview,
}: ProjectExplorerPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const [projects, setProjects] = useState<readonly AgentProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    localStorage.getItem(SELECTED_PROJECT_KEY) ?? '');
  const [descriptor, setDescriptor] = useState<ProjectWorkspaceDescriptor | null>(null);
  const [directories, setDirectories] = useState<ReadonlyMap<string, LoadedDirectory>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'files' | 'content'>('files');
  const [matches, setMatches] = useState<readonly ProjectSearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const searchId = useRef('');

  useEffect(() => {
    let alive = true;
    void window.ezterminal.listAgentProjects(false, undefined, 100).then((page) => {
      if (!alive) return;
      setProjects(page.items);
      setSelectedProjectId((current) => page.items.some((project) => project.projectId === current)
        ? current
        : page.items[0]?.projectId ?? '');
    }).catch(() => {
      if (alive) setProjects([]);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selectedProjectId || !window.ezterminalDesktop) {
      setDescriptor(null);
      return undefined;
    }
    localStorage.setItem(SELECTED_PROJECT_KEY, selectedProjectId);
    let alive = true;
    setDirectories(new Map());
    setExpanded(new Set());
    void window.ezterminalDesktop.describeProjectWorkspace(selectedProjectId).then((result) => {
      if (!alive) return;
      setDescriptor(result.ok ? result.project : null);
    }).catch(() => {
      if (alive) setDescriptor(null);
    });
    return () => { alive = false; };
  }, [selectedProjectId]);

  const loadDirectory = useCallback(async (
    root: ProjectRootDescriptor,
    relativePath: string,
  ): Promise<void> => {
    if (!descriptor || !window.ezterminalDesktop) return;
    const key = directoryKey(root.rootId, relativePath);
    setDirectories((current) => new Map(current).set(key, { loading: true, entries: current.get(key)?.entries ?? [] }));
    const result = await window.ezterminalDesktop.listProjectDirectory({
      projectId: descriptor.projectId,
      rootId: root.rootId,
      relativePath,
    }).catch(() => null);
    setDirectories((current) => new Map(current).set(key, result?.ok
      ? { loading: false, entries: result.entries }
      : { loading: false, error: result?.error ?? 'io-error', entries: [] }));
  }, [descriptor]);

  const toggleDirectory = useCallback((root: ProjectRootDescriptor, relativePath: string): void => {
    const key = directoryKey(root.rootId, relativePath);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        if (!directories.has(key)) void loadDirectory(root, relativePath);
      }
      return next;
    });
  }, [directories, loadDirectory]);

  useEffect(() => {
    if (!descriptor) return;
    setExpanded(new Set(descriptor.roots.map((root) => directoryKey(root.rootId, ''))));
    for (const root of descriptor.roots) void loadDirectory(root, '');
  }, [descriptor, loadDirectory]);

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    const trimmed = query.trim();
    if (!desktop || !descriptor || !trimmed) {
      if (searchId.current) desktop?.cancelProjectWorkspaceSearch(searchId.current);
      setMatches([]);
      setSearching(false);
      setSearchNotice(null);
      return undefined;
    }
    let launchedId = '';
    const timer = window.setTimeout(() => {
      if (searchId.current) desktop.cancelProjectWorkspaceSearch(searchId.current);
      const requestId = `project-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      launchedId = requestId;
      searchId.current = requestId;
      setSearching(true);
      void desktop.searchProjectWorkspace({
        requestId,
        projectId: descriptor.projectId,
        query: trimmed,
        mode: searchMode,
      }).then((result) => {
        if (searchId.current !== requestId) return;
        setSearching(false);
        if (!result.ok) {
          setMatches([]);
          setSearchNotice(t('projectWorkbench.searchUnavailable', { error: result.error }));
          return;
        }
        setMatches(result.matches);
        setSearchNotice(result.truncated
          ? t('projectWorkbench.resultsLimited', { count: result.scannedFiles })
          : null);
      }).catch(() => {
        if (searchId.current === requestId) {
          setSearching(false);
          setSearchNotice(t('projectWorkbench.searchFailed'));
        }
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (launchedId && searchId.current === launchedId) {
        desktop.cancelProjectWorkspaceSearch(launchedId);
        searchId.current = '';
      }
    };
  }, [descriptor, query, searchMode, t]);

  const rootsById = useMemo(() => new Map(descriptor?.roots.map((root) => [root.rootId, root]) ?? []), [descriptor]);

  const renderDirectory = (
    root: ProjectRootDescriptor,
    relativePath: string,
    depth: number,
  ): JSX.Element | null => {
    const key = directoryKey(root.rootId, relativePath);
    const loaded = directories.get(key);
    if (!expanded.has(key)) return null;
    return (
      <div role="list" key={key}>
        {loaded?.loading && (
          <div role="listitem">
            <div className="project-tree__state" style={{ paddingInlineStart: `${String((depth + 1) * 16)}px` }}>{t('projectWorkbench.loading')}</div>
          </div>
        )}
        {loaded?.error && (
          <div role="listitem">
            <div className="project-tree__state project-tree__state--error" role="alert">{loaded.error}</div>
          </div>
        )}
        {loaded?.entries.map((entry) => {
          const childKey = directoryKey(root.rootId, entry.relativePath);
          const isExpanded = expanded.has(childKey);
          return (
            <div key={childKey} role="listitem">
              <button
                type="button"
                aria-expanded={entry.kind === 'directory' ? isExpanded : undefined}
                className="project-tree__row"
                style={{ paddingInlineStart: `${String((depth + 1) * 16)}px` }}
                onClick={() => {
                  if (entry.kind === 'directory') toggleDirectory(root, entry.relativePath);
                  else onOpenFile(descriptor!.projectId, root.rootId, entry.relativePath);
                }}
              >
                {entry.kind === 'directory'
                  ? isExpanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />
                  : <span className="project-tree__spacer" />}
                {entry.kind === 'directory' ? <Folder aria-hidden="true" size={15} /> : <File aria-hidden="true" size={15} />}
                <span>{entry.name}</span>
                {entry.sensitive && <small>{t('projectWorkbench.sensitiveWarning')}</small>}
              </button>
              {entry.kind === 'directory' && renderDirectory(root, entry.relativePath, depth + 1)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="project-explorer" data-testid="project-explorer-panel">
      <div className="project-explorer__project">
        <label htmlFor="project-explorer-project">{t('projectWorkbench.project')}</label>
        <select
          id="project-explorer-project"
          value={selectedProjectId}
          onChange={(event) => setSelectedProjectId(event.target.value)}
        >
          {projects.length === 0 && <option value="">{t('projectWorkbench.noProjects')}</option>}
          {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
        </select>
      </div>
      <div className="project-explorer__search">
        <Search aria-hidden="true" size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchMode === 'files' ? t('projectWorkbench.quickOpen') : t('projectWorkbench.contentSearch')}
          aria-label={searchMode === 'files' ? t('projectWorkbench.quickOpen') : t('projectWorkbench.contentSearch')}
        />
        <select aria-label={t('projectWorkbench.searchMode')} value={searchMode} onChange={(event) => setSearchMode(event.target.value as 'files' | 'content')}>
          <option value="files">{t('projectWorkbench.files')}</option>
          <option value="content">{t('projectWorkbench.content')}</option>
        </select>
      </div>
      {query.trim() ? (
        <div className="project-search-results" role="listbox" aria-label="Project search results">
          {searching && <div className="project-tree__state">{t('projectWorkbench.searching')}</div>}
          {!searching && matches.length === 0 && <div className="project-tree__state">{t('projectWorkbench.noMatches')}</div>}
          {matches.map((match) => (
            <button
              type="button"
              role="option"
              key={`${match.rootId}:${match.relativePath}:${String(match.line ?? 0)}`}
              onClick={() => onOpenFile(
                descriptor!.projectId,
                match.rootId,
                match.relativePath,
                match.line ? { line: match.line, ...(match.column ? { column: match.column } : {}) } : undefined,
              )}
            >
              <span>{rootsById.get(match.rootId)?.name}/{match.relativePath}{match.line ? `:${String(match.line)}` : ''}</span>
              {match.preview && <small>{match.preview}</small>}
            </button>
          ))}
          {searchNotice && <div className="project-tree__state" role="status">{searchNotice}</div>}
        </div>
      ) : (
        <div className="project-tree" role="list" aria-label="Project files">
          {descriptor?.roots.map((root) => {
            const key = directoryKey(root.rootId, '');
            const isExpanded = expanded.has(key);
            return (
              <div key={root.rootId} role="listitem">
                <div className="project-tree__root-row">
                  <button type="button" aria-expanded={isExpanded} onClick={() => toggleDirectory(root, '')}>
                    {isExpanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
                    <Folder aria-hidden="true" size={15} />
                    <span>{root.name}</span>
                  </button>
                  <button type="button" title={t('projectWorkbench.reviewChanges', { root: root.name })} aria-label={t('projectWorkbench.reviewChanges', { root: root.name })} onClick={() => onOpenReview(descriptor.projectId, root.rootId)}>
                    <GitCompare aria-hidden="true" size={15} />
                  </button>
                </div>
                {renderDirectory(root, '', 0)}
              </div>
            );
          })}
          {!descriptor && (
            <div role="listitem">
              <div className="project-tree__state">{t('projectWorkbench.registerProject')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
