import { useEffect, useRef, useState } from 'react';
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { X } from 'lucide-react';

import type { AgentProvider, AgentStatus } from '../shared/agent';
import type { AgentHistoryProvider } from '../shared/agent-history';
import {
  isProjectSessionPanelMetadata,
  type ProjectSessionPanelMetadata,
} from '../shared/project-workspace';
import { useAppTranslation } from './i18n';
import { Badge } from './ui';
import { isFocusableHTMLElement } from './ui/utils';
import {
  isTerminalContextMenuKey,
  TerminalContextMenu,
  type TerminalContextMenuCloseDetail,
  type TerminalContextMenuItem,
} from './TerminalContextMenu';

export const MAX_TAB_TITLE_CHARACTERS = 80;

interface GeneratedPanelTitleLabels {
  readonly terminal: string;
  readonly openClawChat: string;
}

const DEFAULT_GENERATED_PANEL_TITLE_LABELS: GeneratedPanelTitleLabels = {
  terminal: 'Terminal',
  openClawChat: 'OpenClaw Chat',
};

export function generatedPanelTitle(
  panelId: string,
  component: string,
  labels: GeneratedPanelTitleLabels = DEFAULT_GENERATED_PANEL_TITLE_LABELS,
): string {
  const terminalSuffix = /^tab-(\d+)$/.exec(panelId)?.[1];
  if (terminalSuffix) return `${labels.terminal} ${terminalSuffix}`;
  if (component === 'openclaw-chat') return labels.openClawChat;
  return labels.terminal;
}

export function normalizePanelTitle(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return [...trimmed].slice(0, MAX_TAB_TITLE_CHARACTERS).join('');
}

export type WorkspaceTabProps = IDockviewPanelHeaderProps & {
  readonly status?: AgentStatus;
  readonly provider?: AgentProvider;
  readonly providerLabel?: string;
  readonly requestClose: (close: () => void) => void;
  readonly onSplit: (panelId: string, direction: 'right' | 'below') => void;
  readonly onMoveToNewWindow: (panelId: string) => void;
  readonly onMoveToMainWindow: (panelId: string) => void;
  readonly onTitleChanged: (title: string) => void;
};

const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'starting',
  'working',
  'blocked',
  'done',
]);

export function projectSessionBadgeLabel(
  status: AgentStatus | undefined,
  provider: AgentProvider | undefined,
  providerLabel: string | undefined,
  terminalLabel: string,
): string {
  if (!status || !ACTIVE_AGENT_STATUSES.has(status) || !provider) return terminalLabel;
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return providerLabel?.trim() || 'CLI';
}

export interface ProjectSessionTitleCandidate {
  readonly panelId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly badgeKey: string;
  readonly titleMode: 'generated' | 'custom';
}

/** Deterministic generated names; custom titles neither change nor consume a suffix. */
export function generatedProjectSessionTitles(
  candidates: readonly ProjectSessionTitleCandidate[],
): ReadonlyMap<string, string> {
  const groups = new Map<string, ProjectSessionTitleCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.titleMode === 'custom') continue;
    const key = `${candidate.projectId}\0${candidate.badgeKey}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const result = new Map<string, string>();
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const leftNumber = Number.parseInt(/^tab-(\d+)$/u.exec(left.panelId)?.[1] ?? '', 10);
      const rightNumber = Number.parseInt(/^tab-(\d+)$/u.exec(right.panelId)?.[1] ?? '', 10);
      return (Number.isFinite(leftNumber) ? leftNumber : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightNumber) ? rightNumber : Number.MAX_SAFE_INTEGER)
        || left.panelId.localeCompare(right.panelId);
    });
    group.forEach((candidate, index) => {
      result.set(
        candidate.panelId,
        index === 0 ? candidate.projectName : `${candidate.projectName} ${index + 1}`,
      );
    });
  }
  return result;
}

function projectSessionFromParams(value: unknown): ProjectSessionPanelMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const projectSession = (value as Record<string, unknown>).projectSession;
  return isProjectSessionPanelMetadata(projectSession) ? projectSession : null;
}

interface MenuInvocation {
  readonly x: number;
  readonly y: number;
  readonly invoker: HTMLElement | null;
}

const AGENT_HISTORY_PROVIDER_LABEL: Record<AgentHistoryProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

export function agentHistoryTabTitle(
  projectName: string,
  provider: AgentHistoryProvider,
): string {
  const normalizedProjectName = projectName.trim() || 'Project';
  return `${normalizedProjectName} · ${AGENT_HISTORY_PROVIDER_LABEL[provider]}`;
}

function AgentHistoryTab({
  props,
  requestClose,
}: {
  readonly props: IDockviewPanelHeaderProps;
  readonly requestClose: (close: () => void) => void;
}): JSX.Element {
  const [title, setTitle] = useState(props.api.title ?? 'Agent session');
  const provider = (props.params as { provider?: AgentHistoryProvider } | undefined)?.provider;
  const providerLabel = provider ? AGENT_HISTORY_PROVIDER_LABEL[provider] : null;
  const providerSuffix = providerLabel ? ` · ${providerLabel}` : '';
  const identityTitle = providerSuffix && title.endsWith(providerSuffix)
    ? title.slice(0, -providerSuffix.length)
    : title;
  useEffect(() => {
    setTitle(props.api.title ?? 'Agent session');
    const disposable = props.api.onDidTitleChange((event) => setTitle(event.title));
    return () => disposable.dispose();
  }, [props.api]);
  return (
    <div
      className="dv-default-tab agent-history-tab"
      data-provider={provider}
      data-testid="dockview-dv-default-tab"
      onPointerUp={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          requestClose(() => props.api.close());
        }
      }}
    >
      <span className="agent-history-tab__viewport" title={title}>
        <span className="agent-history-tab__label">{identityTitle}</span>
        {providerLabel && (
          <>
            <span className="ez-ui-visually-hidden"> · </span>
            <span className="agent-provider-badge">{providerLabel}</span>
          </>
        )}
      </span>
      <div
        className="dv-default-tab-action agent-history-tab__close"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          requestClose(() => props.api.close());
        }}
      >
        <X aria-hidden="true" />
      </div>
    </div>
  );
}

function ProjectSessionTab({
  props,
  metadata,
  badgeLabel,
  provider,
  activeAgent,
  requestClose,
}: {
  readonly props: IDockviewPanelHeaderProps;
  readonly metadata: ProjectSessionPanelMetadata;
  readonly badgeLabel: string;
  readonly provider?: AgentProvider;
  readonly activeAgent: boolean;
  readonly requestClose: (close: () => void) => void;
}): JSX.Element {
  const [title, setTitle] = useState(props.api.title ?? metadata.projectName);
  useEffect(() => {
    setTitle(props.api.title ?? metadata.projectName);
    const disposable = props.api.onDidTitleChange((event) => setTitle(event.title));
    return () => disposable.dispose();
  }, [metadata.projectName, props.api]);
  return (
    <div
      className="dv-default-tab project-session-tab"
      data-provider={activeAgent ? provider : undefined}
      data-testid="dockview-dv-default-tab"
      onPointerUp={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          requestClose(() => props.api.close());
        }
      }}
    >
      <span className="project-session-tab__viewport" title={`${title} · ${badgeLabel}`}>
        <span className="project-session-tab__label">{title}</span>
        <Badge
          className="project-session-tab__badge agent-provider-badge"
          size="sm"
          variant={activeAgent ? 'accent' : 'neutral'}
        >
          {badgeLabel}
        </Badge>
      </span>
      <div
        className="dv-default-tab-action project-session-tab__close"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          requestClose(() => props.api.close());
        }}
      >
        <X aria-hidden="true" />
      </div>
    </div>
  );
}

/** Dockview tab with progressive context actions and an IME-safe inline title
 * editor. Risky close remains delegated to App's existing atomic guard. */
export function WorkspaceTab({
  status,
  provider,
  providerLabel,
  requestClose,
  onSplit,
  onMoveToNewWindow,
  onMoveToMainWindow,
  onTitleChanged,
  ...props
}: WorkspaceTabProps): JSX.Element {
  const { t } = useAppTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const [menu, setMenu] = useState<MenuInvocation | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [projectSession, setProjectSession] = useState<ProjectSessionPanelMetadata | null>(() => {
    return projectSessionFromParams(props.api.getParameters?.())
      ?? projectSessionFromParams(props.params);
  });
  const generatedTitleLabels: GeneratedPanelTitleLabels = {
    terminal: t('workspaceTab.terminal'),
    openClawChat: t('workspaceTab.openClawChat'),
  };
  const badgeLabel = projectSessionBadgeLabel(
    status,
    provider,
    providerLabel,
    generatedTitleLabels.terminal,
  );

  useEffect(() => {
    const storedParams = props.api.getParameters?.();
    const storedProjectSession = projectSessionFromParams(storedParams);
    const current = storedProjectSession ?? projectSessionFromParams(props.params);
    setProjectSession(current);
    if (current && !storedProjectSession) {
      // Dockview restores initial params into renderer props before its panel
      // API store. Synchronize the safe metadata so later title reconciliation
      // sees restored project tabs too.
      props.api.updateParameters({
        ...(storedParams ?? {}),
        projectSession: current,
      });
    }
    const disposable = props.api.onDidParametersChange?.((next) => {
      setProjectSession(projectSessionFromParams(next));
    });
    return () => disposable?.dispose();
  }, [props.api, props.params]);

  const startRename = (): void => {
    cancelRenameRef.current = false;
    setDraft(props.api.title ?? generatedPanelTitle(props.api.id, props.api.component, generatedTitleLabels));
    setRenaming(true);
  };

  const finishRename = (): void => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenaming(false);
      return;
    }
    const customTitle = draft.trim().length > 0;
    const next = normalizePanelTitle(
      draft,
      projectSession?.projectName
        ?? generatedPanelTitle(props.api.id, props.api.component, generatedTitleLabels),
    );
    if (projectSession) {
      const nextMetadata: ProjectSessionPanelMetadata = {
        ...projectSession,
        titleMode: customTitle ? 'custom' : 'generated',
      };
      props.api.updateParameters({
        ...(props.api.getParameters?.() ?? props.params ?? {}),
        projectSession: nextMetadata,
      });
      setProjectSession(nextMetadata);
    }
    props.api.setTitle(next);
    onTitleChanged(next);
    setRenaming(false);
  };

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const openMenu = (x: number, y: number): void => {
    props.api.setActive();
    const active = rootRef.current?.ownerDocument.activeElement;
    setMenu({
      x,
      y,
      invoker: isFocusableHTMLElement(active) && rootRef.current?.contains(active)
        ? active
        : null,
    });
  };

  const closeMenu = (detail: TerminalContextMenuCloseDetail): void => {
    const invocation = menu;
    setMenu(null);
    if (!invocation || detail.reason !== 'escape') return;
    (rootRef.current?.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      if (invocation.invoker?.isConnected) invocation.invoker.focus();
      else rootRef.current?.closest<HTMLElement>('[role="tab"]')?.focus();
    });
  };

  const menuItems: readonly TerminalContextMenuItem[] = [
    { action: 'rename', label: t('workspaceTab.rename'), shortcut: 'F2', onClick: startRename },
    {
      action: 'split-right',
      label: t('workspace.splitRight'),
      onClick: () => onSplit(props.api.id, 'right'),
    },
    {
      action: 'split-below',
      label: t('workspace.splitBelow'),
      onClick: () => onSplit(props.api.id, 'below'),
    },
    {
      action: 'move-to-new-window',
      label: t('workspaceTab.moveToNewWindow'),
      disabled: props.api.location.type === 'popout' && props.api.group.panels.length === 1,
      onClick: () => onMoveToNewWindow(props.api.id),
    },
    {
      action: 'move-to-main-window',
      label: t('workspaceTab.moveToMainWindow'),
      disabled: props.api.location.type === 'grid',
      onClick: () => onMoveToMainWindow(props.api.id),
    },
    {
      action: 'close',
      label: t('common.close'),
      onClick: () => requestClose(() => props.api.close()),
    },
  ];

  return (
    <div
      ref={rootRef}
      className={[
        'agent-aware-tab',
        props.api.component === 'agent-session' ? 'agent-aware-tab--history' : '',
      ].filter(Boolean).join(' ')}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY);
      }}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest('.dv-default-tab-action')) return;
        event.preventDefault();
        startRename();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          startRename();
          return;
        }
        if (!isTerminalContextMenuKey(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = rootRef.current?.getBoundingClientRect();
        openMenu(rect?.left ?? 8, rect?.bottom ?? 8);
      }}
    >
      {status && status !== 'done' && (
        <span
          className={`agent-status-dot agent-status-dot--${status}`}
          aria-label={t('workspaceTab.agentStatus', { status })}
          title={t('workspaceTab.agentStatus', { status })}
        />
      )}

      {renaming ? (
        <input
          ref={inputRef}
          className="workspace-tab-rename"
          value={draft}
          maxLength={MAX_TAB_TITLE_CHARACTERS}
          aria-label={t('workspaceTab.title')}
          data-testid="workspace-tab-rename"
          onChange={(event) => setDraft(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onBlur={finishRename}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key === 'Process') return;
            if (event.key === 'Enter') {
              event.preventDefault();
              finishRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancelRenameRef.current = true;
              setRenaming(false);
              requestAnimationFrame(() => rootRef.current?.closest<HTMLElement>('[role="tab"]')?.focus());
            }
          }}
        />
      ) : (
        props.api.component === 'agent-session' ? (
          <AgentHistoryTab props={props} requestClose={requestClose} />
        ) : projectSession ? (
          <ProjectSessionTab
            props={props}
            metadata={projectSession}
            badgeLabel={badgeLabel}
            provider={provider}
            activeAgent={Boolean(status && provider && ACTIVE_AGENT_STATUSES.has(status))}
            requestClose={requestClose}
          />
        ) : (
          <DockviewDefaultTab
            {...props}
            closeActionOverride={() => requestClose(() => props.api.close())}
          />
        )
      )}
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
          ariaLabel={t('workspaceTab.actions')}
          shortcutLabel={(shortcut) => t('terminalContext.shortcut', { shortcut })}
          testId="workspace-tab-context-menu"
          itemTestIdPrefix="tab-ctx"
          ownerDocument={rootRef.current?.ownerDocument}
        />
      )}
    </div>
  );
}
