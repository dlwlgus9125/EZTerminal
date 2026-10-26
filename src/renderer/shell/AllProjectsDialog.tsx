import { MoreHorizontal, Pin, PinOff, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import type { AgentProjectSummary } from '../../shared/agent-history';
import { DeferredSearchInput } from '../DeferredSearchInput';
import { formatCwd } from '../format-cwd';
import { useAppTranslation } from '../i18n';
import type { ProjectRegistryAccess } from '../ProjectDialogs';
import { Button, Dialog, EmptyState, ErrorState, Field, Glyph, IconButton, LoadingState, Menu, MenuItem } from '../ui';
import { useShellText } from './shell-text';
import './project-dialogs.css';

const PAGE_SIZE = 40;
/** Room a row's menu needs below it; with less, it opens upward (the dialog body clips). */
const MENU_ROOM = 150;

export interface AllProjectsDialogProps {
  readonly access: ProjectRegistryAccess;
  /** Changes when a dialog opened from here changed the registry: the list is read again. */
  readonly reloadKey: number;
  readonly onClose: () => void;
  readonly onOpen: (project: AgentProjectSummary) => void;
  /** Absent where folders cannot be chosen (no add button). */
  readonly onAdd?: () => void;
  readonly onEdit: (project: AgentProjectSummary) => void;
  readonly onCliHistory: (project: AgentProjectSummary) => void;
  readonly onDelete: (project: AgentProjectSummary) => void;
  /** A pin changed: the top bar's tabs follow. */
  readonly onChanged: () => void;
}

/** Every project: find one, open its board, pin it, or manage it (edit, CLI history, delete). */
export function AllProjectsDialog({ access, reloadKey, onClose, onOpen, onAdd, onEdit, onCliHistory, onDelete, onChanged }: AllProjectsDialogProps): JSX.Element {
  const { t } = useAppTranslation();
  const { text } = useShellText();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<readonly AgentProjectSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [menuPlacement, setMenuPlacement] = useState<'bottom-end' | 'top-end'>('bottom-end');
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (from?: string): Promise<void> => {
    const current = ++generation.current;
    if (from) setLoadingMore(true);
    else setStatus('loading');
    const page = await access.listAgentProjects(revision > 0 || reloadKey > 0, from, PAGE_SIZE, debounced || undefined).catch(() => null);
    if (current !== generation.current) return;
    setLoadingMore(false);
    if (!page) {
      if (!from) setStatus('error');
      else setActionError(t('agentHub.projects.loadFailed'));
      return;
    }
    setItems((previous) => (from ? [...previous, ...page.items] : page.items));
    setCursor(page.nextCursor);
    setStatus('ready');
  }, [access, debounced, reloadKey, revision, t]);

  useEffect(() => { void load(); }, [load]);

  const togglePin = async (project: AgentProjectSummary): Promise<void> => {
    if (pinning) return;
    setPinning(project.projectId);
    setActionError(null);
    const result = await access.saveAgentProject({
      projectId: project.projectId,
      name: project.name,
      primaryRoot: project.primaryRoot,
      additionalRoots: project.additionalRoots,
      pinned: !project.pinned,
    }).catch(() => ({ ok: false, reason: 'invalid' } as const));
    setPinning(null);
    if (!result.ok) {
      setActionError(t('agentHub.projects.saveFailed'));
      return;
    }
    onChanged();
    // Pinned projects come first: read the order again.
    setRevision((value) => value + 1);
  };

  // A row's menu opens upward when the dialog body has no room for it below.
  const placeMenu = (event: MouseEvent<HTMLElement>): void => {
    const trigger = event.currentTarget.getBoundingClientRect();
    const body = event.currentTarget.closest('.ez-ui-dialog__body')?.getBoundingClientRect();
    setMenuPlacement(body && body.bottom - trigger.bottom < MENU_ROOM ? 'top-end' : 'bottom-end');
  };
  // Escape in a row's menu closes the menu, not the whole dialog. (No instanceof: in a popout window
  // the target belongs to that window's Element.)
  const keepEscapeInMenu = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as { closest?: (selector: string) => unknown };
    if (event.key === 'Escape' && typeof target.closest === 'function' && target.closest('[role="menu"]')) event.stopPropagation();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={text('모든 프로젝트', 'All projects')}
      closeLabel={text('닫기', 'Close')}
      size="lg"
      className="ez-project-dialog"
      testId="all-projects-dialog"
      footer={onAdd && (
        <Button variant="primary" leadingIcon={<Plus aria-hidden="true" />} onClick={onAdd} data-testid="all-projects-add">
          {t('agentHub.projects.add')}
        </Button>
      )}
    >
      <div className="ez-project-list" onKeyDown={keepEscapeInMenu}>
        <Field label={t('agentHub.projects.searchLabel')} labelHidden>
          <DeferredSearchInput
            variant="ui"
            value={query}
            placeholder={t('agentHub.projects.searchPlaceholder')}
            onQueryChange={setQuery}
            testId="all-projects-search"
          />
        </Field>
        {actionError && <p className="ez-project-list__error" role="alert">{actionError}</p>}
        {status === 'loading' && items.length === 0 && <LoadingState label={t('agentHub.projects.loading')} />}
        {status === 'error' && (
          <ErrorState
            title={t('agentHub.projects.loadFailed')}
            action={<Button size="sm" onClick={() => void load()}>{t('common.retry')}</Button>}
          />
        )}
        {status === 'ready' && items.length === 0 && (
          <EmptyState
            title={debounced ? t('agentHub.projects.noMatches') : text('아직 프로젝트가 없습니다.', 'No projects yet.')}
            {...(debounced ? {} : { description: text('작업할 폴더를 프로젝트로 추가하세요.', 'Add a folder you work in as a project.') })}
          />
        )}
        {items.length > 0 && (
          <ul className="ez-project-list__rows" aria-label={text('프로젝트', 'Projects')}>
            {items.map((project) => {
              const manage = t('agentHub.projects.manage', { name: project.name });
              return (
                <li key={project.projectId} className="ez-project-list__row">
                  <button
                    type="button"
                    className="ez-project-list__open"
                    onClick={() => onOpen(project)}
                    title={[project.primaryRoot, ...project.additionalRoots].join('\n')}
                    data-testid={`all-projects-open-${project.projectId}`}
                  >
                    <span className="ez-project-list__name">
                      {project.pinned && <Glyph name="pin" size={14} />}
                      {project.name}
                      {project.pinned && <span className="ez-ui-visually-hidden">{text(' (고정됨)', ' (pinned)')}</span>}
                    </span>
                    <span className="ez-project-list__path">
                      {formatCwd(project.primaryRoot)}
                      {project.additionalRoots.length > 0 ? ` · +${project.additionalRoots.length}` : ''}
                    </span>
                  </button>
                  <IconButton
                    icon={project.pinned ? PinOff : Pin}
                    aria-label={`${project.pinned ? t('agentHub.projects.unpin') : t('agentHub.projects.pin')}: ${project.name}`}
                    disabled={pinning !== null}
                    onClick={() => void togglePin(project)}
                    data-testid={`all-projects-pin-${project.projectId}`}
                  />
                  <Menu
                    label={manage}
                    placement={menuPlacement}
                    trigger={<IconButton icon={MoreHorizontal} aria-label={manage} onClick={placeMenu} />}
                  >
                    <MenuItem onSelect={() => onEdit(project)}>{t('agentHub.projects.edit')}</MenuItem>
                    <MenuItem onSelect={() => onCliHistory(project)}>{text('CLI 기록', 'CLI history')}</MenuItem>
                    <MenuItem destructive onSelect={() => onDelete(project)}>{t('agentHub.projects.delete')}</MenuItem>
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && status === 'ready' && (
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void load(cursor)} data-testid="all-projects-more">
            {loadingMore ? t('agentHub.projects.loading') : t('agentHub.projects.loadMore')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
