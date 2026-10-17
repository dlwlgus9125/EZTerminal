import { ChevronDown, ChevronRight, Folder, FolderGit2, FolderKanban, GitBranch, HardDrive, MessageSquare, Pin, Search, SquareTerminal, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useAppTranslation } from './i18n';
import { Button, Input } from './ui';
import { visibleProjectConversationRows, type ProjectConversationNode, type ProjectNavigationTarget } from './project-conversation-tree-model';
import './project-conversation-tree.css';

interface NavigationViewState {
  readonly expanded: readonly string[];
  readonly query: string;
  readonly view: 'projects' | 'recent';
  readonly includeArchived: boolean;
  readonly selectedId?: string | null;
  readonly scrollTop: number;
}

function restoreView(key: string, nodes: readonly ProjectConversationNode[]): NavigationViewState {
  const initial: NavigationViewState = { expanded: nodes[0] ? [nodes[0].id] : [], query: '', view: 'projects', includeArchived: false, scrollTop: 0 };
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved !== 'object') return initial;
    const value = saved as Partial<NavigationViewState>;
    return {
      expanded: Array.isArray(value.expanded) ? value.expanded.filter((id): id is string => typeof id === 'string').slice(0, 500) : initial.expanded,
      query: typeof value.query === 'string' ? value.query.slice(0, 500) : '',
      view: value.view === 'recent' ? 'recent' : 'projects', includeArchived: value.includeArchived === true,
      selectedId: typeof value.selectedId === 'string' ? value.selectedId : undefined,
      scrollTop: typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0,
    };
  } catch { return initial; }
}

export interface ProjectConversationTreeProps {
  readonly nodes: readonly ProjectConversationNode[];
  /** Host/authority identity, never a token or raw credential. */
  readonly persistenceScope: string;
  readonly mobile?: boolean;
  readonly loading?: boolean;
  readonly offline?: boolean;
  readonly selectedId?: string | null;
  readonly onOpen: (target: ProjectNavigationTarget) => void;
  readonly onInspectProject?: (projectId: string) => void;
  readonly onCollapseProject?: (projectId: string) => void;
  readonly onSearchAll?: (query: string) => void;
  readonly renderProjectActions?: (projectId: string) => ReactNode;
  readonly renderTerminalActions?: (sessionId: string, title: string) => ReactNode;
  /** Review, merge and new-chat actions for a worktree row. */
  readonly renderWorkspaceActions?: (target: Extract<ProjectNavigationTarget, { kind: 'workspace' }>) => ReactNode;
  readonly projectStatus?: Readonly<Record<string, { readonly loading?: boolean; readonly error?: string; readonly hasMore?: boolean }>>;
  readonly onLoadMore?: (projectId: string) => void;
  readonly searchStatus?: { readonly loading?: boolean; readonly error?: string; readonly hasMore?: boolean };
  readonly onLoadMoreSearch?: () => void;
}

export function ProjectConversationTree(props: ProjectConversationTreeProps): JSX.Element {
  return <ProjectConversationTreeView key={props.persistenceScope} {...props} />;
}

function ProjectConversationTreeView({ nodes, persistenceScope, mobile, loading, offline, selectedId, onOpen, onInspectProject, onCollapseProject, onSearchAll, renderProjectActions, renderTerminalActions, renderWorkspaceActions, projectStatus, onLoadMore, searchStatus, onLoadMoreSearch }: ProjectConversationTreeProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const storageKey = `ezterminal:project-navigation:v1:${persistenceScope}`;
  const [state, setState] = useState(() => restoreView(storageKey, nodes));
  const [focusedId, setFocusedId] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(state.scrollTop);
  const inspected = useRef(new Set<string>());
  const initialized = useRef(nodes.length > 0);
  const revealedSelection = useRef<string>();
  const expanded = useMemo(() => new Set(state.expanded), [state.expanded]);
  const rows = useMemo(() => visibleProjectConversationRows(nodes, { ...state, expanded }), [nodes, state, expanded]);
  const flat = state.view === 'recent' || Boolean(state.query.trim());
  const activeId = selectedId === undefined ? state.selectedId : selectedId ?? undefined;
  const focused = rows.some(row => row.node.id === focusedId) ? focusedId : rows.find(row => row.node.id === activeId)?.node.id ?? rows[0]?.node.id;

  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Navigation stays usable when local storage is unavailable. */ }
  }, [state, storageKey]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const restore = (): void => {
      if (pendingScroll.current === null || !rows.length) return;
      element.scrollTop = pendingScroll.current;
      if (Math.abs(element.scrollTop - pendingScroll.current) < 1) pendingScroll.current = null;
    };
    restore();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(restore);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, [rows.length, state.query, state.view]);
  useEffect(() => {
    // An initially empty asynchronous project list should still reveal its first project.
    if (nodes.length && !initialized.current) {
      initialized.current = true;
      if (!state.expanded.length && !state.selectedId) setState(current => ({ ...current, expanded: [nodes[0].id] }));
    }
  }, [nodes, state.expanded.length, state.selectedId]);
  useEffect(() => {
    for (const node of nodes) {
      if (expanded.has(node.id) && !inspected.current.has(node.target.projectId)) {
        inspected.current.add(node.target.projectId);
        onInspectProject?.(node.target.projectId);
      }
    }
  }, [nodes, expanded, onInspectProject]);
  useEffect(() => {
    if (!activeId) return;
    const find = (items: readonly ProjectConversationNode[], ancestors: readonly string[]): readonly string[] | undefined => {
      for (const node of items) {
        if (node.id === activeId) return ancestors;
        const found = node.children ? find(node.children, [...ancestors, node.id]) : undefined;
        if (found) return found;
      }
      return undefined;
    };
    const ancestors = find(nodes, []);
    if (ancestors) {
      const path = JSON.stringify([activeId, ...ancestors]);
      if (revealedSelection.current === path) return;
      revealedSelection.current = path;
      setState(current => ({ ...current, expanded: [...new Set([...current.expanded, ...ancestors])] }));
    }
  }, [activeId, nodes]);
  useEffect(() => {
    if (!flat) return;
    const timer = window.setTimeout(() => onSearchAll?.(state.query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [flat, state.query, onSearchAll]);

  const toggle = (node: ProjectConversationNode): void => {
    if (!expanded.has(node.id) && node.target.kind === 'project') onInspectProject?.(node.target.projectId);
    if (expanded.has(node.id) && node.target.kind === 'project') onCollapseProject?.(node.target.projectId);
    setState(current => ({ ...current, expanded: current.expanded.includes(node.id)
      ? current.expanded.filter(id => id !== node.id) : [...current.expanded, node.id] }));
  };
  const open = (node: ProjectConversationNode): void => {
    setState(current => ({ ...current, selectedId: node.id }));
    onOpen(node.target);
  };
  const focusRow = (index: number): void => {
    const next = rows[index];
    if (!next) return;
    setFocusedId(next.node.id);
    scroll.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    const row = rows[index];
    if (!row || event.target !== event.currentTarget) return;
    if (event.key === 'ArrowDown') focusRow(Math.min(rows.length - 1, index + 1));
    else if (event.key === 'ArrowUp') focusRow(Math.max(0, index - 1));
    else if (event.key === 'Home') focusRow(0);
    else if (event.key === 'End') focusRow(rows.length - 1);
    else if (event.key === 'ArrowRight' && !flat && row.node.children) {
      if (!row.expanded) toggle(row.node);
      else if (rows[index + 1]?.parentId === row.node.id) focusRow(index + 1);
    } else if (event.key === 'ArrowLeft' && !flat) {
      if (row.expanded) toggle(row.node);
      else if (row.parentId) focusRow(rows.findIndex(candidate => candidate.node.id === row.parentId));
    } else if (event.key === 'Enter' || event.key === ' ') open(row.node);
    else return;
    event.preventDefault();
  };
  const kindLabel = (node: ProjectConversationNode): string => ({
    project: text('프로젝트', 'Project'), subproject: text('소프로젝트', 'Subproject'),
    stage: text('단계', 'Stage'), conversation: node.subagent ? text('서브에이전트', 'Subagent') : node.source === 'native' ? 'CLI' : text('대화', 'Chat'),
    terminal: text('터미널', 'Terminal'),
    workspace: node.target.kind === 'workspace' && node.target.local ? text('로컬', 'Local') : text('워크트리', 'Worktree'),
  })[node.target.kind];
  const date = (value: number): string => value > 0 ? new Intl.DateTimeFormat(ko ? 'ko' : 'en', { month: 'short', day: 'numeric' }).format(value) : '';
  const statusLabel = (status: string | undefined): string | undefined => ({
    working: text('응답 중', 'Working'), running: text('진행 중', 'Running'), starting: text('시작 중', 'Starting'),
    blocked: text('확인 대기', 'Needs attention'), error: text('오류', 'Error'), queued: text('대기 중', 'Queued'),
    'delivery-uncertain': text('전송 확인 필요', 'Delivery unconfirmed'), completed: text('완료됨', 'Completed'),
    review: text('검토 대기', 'Ready to review'), done: text('완료', 'Done'), 'needs-attention': text('확인 대기', 'Needs attention'),
    failed: text('오류', 'Error'),
  } as Readonly<Record<string, string>>)[status ?? ''];
  /** A worktree is worked in, not answered: its "working" reads as work in progress. */
  const nodeStatusLabel = (node: ProjectConversationNode, status = node.status): string | undefined =>
    node.target.kind === 'workspace' && status === 'working' ? text('작업 중', 'In progress') : statusLabel(status);
  /** "1 subagent needs attention": what a collapsed parent is hiding. */
  const attentionLabel = (attention: NonNullable<ProjectConversationNode['attention']>): string => {
    const label = statusLabel(attention.status) ?? attention.status;
    return ko ? `서브에이전트 ${attention.count}개 ${label}` : `${attention.count} subagent${attention.count === 1 ? '' : 's'} · ${label}`;
  };

  return <section className="project-conversation-tree" data-mobile={mobile || undefined} aria-label={text('프로젝트와 대화', 'Projects and conversations')} data-testid="project-conversation-tree">
    <div className="project-conversation-tree__search"><Search aria-hidden="true" /><Input value={state.query} maxLength={500}
      aria-label={text('프로젝트·소프로젝트·대화 제목 검색', 'Search project, subproject and conversation titles')}
      placeholder={text('프로젝트·소프로젝트·대화 검색', 'Search projects and conversations')}
      onChange={event => { pendingScroll.current = 0; setState(current => ({ ...current, query: event.target.value, scrollTop: 0 })); }} /></div>
    <div className="project-conversation-tree__filters" role="group" aria-label={text('목록 보기', 'List view')}>
      <Button size="sm" variant="ghost" aria-pressed={state.view === 'projects'} onClick={() => { pendingScroll.current = 0; setState(current => ({ ...current, view: 'projects', scrollTop: 0 })); }}>{text('프로젝트별', 'By project')}</Button>
      <Button size="sm" variant="ghost" aria-pressed={state.view === 'recent'} onClick={() => { pendingScroll.current = 0; setState(current => ({ ...current, view: 'recent', scrollTop: 0 })); }}>{text('최근순', 'Recent')}</Button>
      <label><input type="checkbox" checked={state.includeArchived} onChange={event => setState(current => ({ ...current, includeArchived: event.target.checked }))} />{text('보관 포함', 'Archived')}</label>
    </div>
    {offline && <p className="project-conversation-tree__notice" role="status">{text('오프라인 · 마지막으로 확인한 목록', 'Offline · Last received list')}</p>}
    {loading && <p className="project-conversation-tree__notice" role="status">{text('목록 불러오는 중', 'Loading list')}</p>}
    {flat && searchStatus?.loading && <p className="project-conversation-tree__notice" role="status">{text('이전 대화 검색 중', 'Searching conversation history')}</p>}
    {flat && searchStatus?.error && <p className="project-conversation-tree__notice" role="alert">{searchStatus.error}</p>}
    <div className="project-conversation-tree__scroll" ref={scroll}
      onWheel={() => { pendingScroll.current = null; }} onPointerDown={() => { pendingScroll.current = null; }}
      onKeyDown={() => { pendingScroll.current = null; }}
      onScroll={event => {
        if (pendingScroll.current !== null) return;
        const scrollTop = event.currentTarget.scrollTop;
        setState(current => current.scrollTop === scrollTop ? current : { ...current, scrollTop });
      }}>
      <div role="tree" aria-label={text('프로젝트와 대화 목록', 'Project and conversation list')} aria-busy={loading || undefined}>
        {rows.map((row, index) => {
          const { node } = row;
          const branch = !flat && Boolean(node.children);
          const Icon = node.subagent ? Users : node.target.kind === 'workspace'
            ? node.target.local ? HardDrive : FolderGit2
            : { project: Folder, subproject: FolderKanban, stage: GitBranch, conversation: MessageSquare, terminal: SquareTerminal }[node.target.kind];
          const status = node.target.kind === 'project' ? projectStatus?.[node.target.projectId] : undefined;
          // Collapsed, a parent shows what its subagents need; open, each child shows its own.
          // A parent already waiting for the same thing (its subagent's approval lives on it) says it once.
          const attention = !flat && !row.expanded && node.attention?.status !== node.status ? node.attention : undefined;
          const rowStatus = attention && (!node.status || node.status === 'completed' || node.status === 'idle') ? attention.status : node.status;
          return <div key={node.id} role="none" className="project-conversation-tree__entry">
            <div role="treeitem" aria-level={row.depth + 1} aria-expanded={branch ? row.expanded : undefined} aria-selected={activeId === node.id}
              aria-label={`${node.title} · ${kindLabel(node)}${node.providerLabel ? ` · ${node.providerLabel}` : ''}${node.archived ? ` · ${text('보관됨', 'Archived')}` : ''}${statusLabel(node.status) && node.status !== 'completed' ? ` · ${statusLabel(node.status)}` : ''}`}
              tabIndex={focused === node.id ? 0 : -1} onFocus={() => setFocusedId(node.id)} onKeyDown={event => onKey(event, index)}
              data-testid={node.target.kind === 'project' ? mobile ? 'mobile-planning-project' : `agent-project-open-${node.target.projectId}` : undefined}
              data-session-id={node.target.kind === 'terminal' || node.target.kind === 'conversation' ? node.target.sessionId : undefined}
              onClick={() => open(node)} className="project-conversation-tree__row" style={{ '--project-tree-depth': row.depth } as CSSProperties}
              data-kind={node.target.kind} data-selected={activeId === node.id || undefined}>
              {branch ? <button type="button" className="project-conversation-tree__expand" tabIndex={-1}
                aria-label={`${row.expanded ? text('접기', 'Collapse') : text('펼치기', 'Expand')}: ${node.title}`}
                onClick={event => { event.stopPropagation(); toggle(node); }}>
                {row.expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              </button> : <span className="project-conversation-tree__spacer" />}
              <Icon className="project-conversation-tree__icon" aria-hidden="true" />
              <span className="project-conversation-tree__label" title={node.title}><strong>{node.pinned && <Pin aria-hidden="true" />}{node.title}</strong>
                <small>{(flat || node.target.kind === 'conversation' && row.depth === 1 && node.path.length > 1) && node.path.length ? `${node.path.join(' / ')} · ` : ''}{node.providerLabel ? `${node.providerLabel}${node.source === 'native' ? ' CLI' : ''}` : kindLabel(node)}
                  {node.archived ? ` · ${text('보관됨', 'Archived')}` : ''}{node.target.kind === 'conversation' || node.target.kind === 'terminal' ? ` · ${date(node.updatedAt)}` : ''}
                  {node.target.kind === 'stage' && node.children?.length ? ` · ${text('대화', 'Chats')} ${node.children.length}` : ''}
                  {node.target.kind === 'conversation' && node.children?.length && !attention ? ` · ${text('서브에이전트', 'Subagents')} ${node.children.length}` : ''}
                  {node.subagentType ? ` · ${node.subagentType}` : ''}
                  {nodeStatusLabel(node) ? ` · ${nodeStatusLabel(node)}` : ''}
                  {attention ? ` · ${attentionLabel(attention)}` : ''}</small>
              </span>
              {/* What needs you shows at a glance: working, waiting for you, failed or queued. */}
              {nodeStatusLabel(node, rowStatus) && rowStatus !== 'completed' && rowStatus !== 'done' && <span className="project-conversation-tree__status" data-status={rowStatus} aria-hidden="true" />}
              {node.target.kind === 'workspace' && renderWorkspaceActions && <span className="project-conversation-tree__actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{renderWorkspaceActions(node.target)}</span>}
              {node.target.kind === 'project' && <span className="project-conversation-tree__actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{renderProjectActions?.(node.target.projectId)}</span>}
              {node.target.kind === 'terminal' && !node.archived && <span className="project-conversation-tree__actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{renderTerminalActions?.(node.target.sessionId, node.title)}</span>}
            {node.target.kind === 'project' && (row.expanded || flat) && <div className="project-conversation-tree__project-status" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
              {status?.loading && <p role="status" className="project-conversation-tree__notice">{text('대화·소프로젝트 확인 중', 'Loading conversations and subprojects')}</p>}
              {status?.error && <div role="alert" className="project-conversation-tree__notice"><span>{status.error}</span><Button size="sm" variant="ghost" onClick={() => onInspectProject?.(node.target.projectId)}>{text('다시 시도', 'Retry')}</Button></div>}
              {!status?.loading && !status?.error && node.children?.length === 0 && <p className="project-conversation-tree__notice">{text('아직 대화나 소프로젝트가 없습니다.', 'No conversations or subprojects yet.')}</p>}
            </div>}
            </div>
            {!flat && (row.depth > 0 || row.expanded) && rows[index + 1]?.node.target.projectId !== node.target.projectId && projectStatus?.[node.target.projectId]?.hasMore &&
              <Button size="sm" variant="ghost" disabled={projectStatus[node.target.projectId]?.loading} onClick={() => onLoadMore?.(node.target.projectId)}>{text('대화 더 불러오기', 'Load more conversations')}</Button>}
          </div>;
        })}
      </div>
      {!loading && !rows.length && <p role="status" className="project-conversation-tree__notice">{state.query ? text('일치하는 제목이 없습니다.', 'No matching titles.') : text('아직 표시할 항목이 없습니다.', 'No items yet.')}</p>}
      {flat && searchStatus?.hasMore && <Button size="sm" variant="ghost" onClick={onLoadMoreSearch}>{text('대화 더 불러오기', 'Load more conversations')}</Button>}
    </div>
  </section>;
}
