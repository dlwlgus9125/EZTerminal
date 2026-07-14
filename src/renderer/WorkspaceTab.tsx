import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';

import type { AgentStatus } from '../shared/agent';
import {
  isTerminalContextMenuKey,
  TerminalContextMenu,
  type TerminalContextMenuCloseDetail,
  type TerminalContextMenuItem,
} from './TerminalContextMenu';

export const MAX_TAB_TITLE_CHARACTERS = 80;

export function generatedPanelTitle(panelId: string, component: string): string {
  const terminalSuffix = /^tab-(\d+)$/.exec(panelId)?.[1];
  if (terminalSuffix) return `Terminal ${terminalSuffix}`;
  if (component === 'openclaw-chat') return 'OpenClaw Chat';
  return 'Terminal';
}

export function normalizePanelTitle(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return [...trimmed].slice(0, MAX_TAB_TITLE_CHARACTERS).join('');
}

export type WorkspaceTabProps = IDockviewPanelHeaderProps & {
  readonly status?: AgentStatus;
  readonly requestClose: (close: () => void) => void;
  readonly onSplit: (panelId: string, direction: 'right' | 'below') => void;
  readonly onTitleChanged: (title: string) => void;
};

interface MenuInvocation {
  readonly x: number;
  readonly y: number;
  readonly invoker: HTMLElement | null;
}

/** Dockview tab with progressive context actions and an IME-safe inline title
 * editor. Risky close remains delegated to App's existing atomic guard. */
export function WorkspaceTab({
  status,
  requestClose,
  onSplit,
  onTitleChanged,
  ...props
}: WorkspaceTabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const [menu, setMenu] = useState<MenuInvocation | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const startRename = (): void => {
    cancelRenameRef.current = false;
    setDraft(props.api.title ?? generatedPanelTitle(props.api.id, props.api.component));
    setRenaming(true);
  };

  const finishRename = (): void => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenaming(false);
      return;
    }
    const next = normalizePanelTitle(
      draft,
      generatedPanelTitle(props.api.id, props.api.component),
    );
    props.api.setTitle(next);
    onTitleChanged(next);
    setRenaming(false);
  };

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const openMenu = (x: number, y: number): void => {
    props.api.setActive();
    const active = document.activeElement;
    setMenu({
      x,
      y,
      invoker: active instanceof HTMLElement && rootRef.current?.contains(active) ? active : null,
    });
  };

  const closeMenu = (detail: TerminalContextMenuCloseDetail): void => {
    const invocation = menu;
    setMenu(null);
    if (!invocation || detail.reason !== 'escape') return;
    requestAnimationFrame(() => {
      if (invocation.invoker?.isConnected) invocation.invoker.focus();
      else rootRef.current?.closest<HTMLElement>('[role="tab"]')?.focus();
    });
  };

  const menuItems: readonly TerminalContextMenuItem[] = [
    { action: 'rename', label: 'Rename', shortcut: 'F2', onClick: startRename },
    {
      action: 'split-right',
      label: 'Split Right',
      onClick: () => onSplit(props.api.id, 'right'),
    },
    {
      action: 'split-below',
      label: 'Split Below',
      onClick: () => onSplit(props.api.id, 'below'),
    },
    {
      action: 'close',
      label: 'Close',
      onClick: () => requestClose(() => props.api.close()),
    },
  ];

  return (
    <div
      ref={rootRef}
      className="agent-aware-tab"
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
          aria-label={`Agent ${status}`}
          title={`Agent ${status}`}
        />
      )}

      {renaming ? (
        <input
          ref={inputRef}
          className="workspace-tab-rename"
          value={draft}
          maxLength={MAX_TAB_TITLE_CHARACTERS}
          aria-label="Tab title"
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
        <DockviewDefaultTab
          {...props}
          closeActionOverride={() => requestClose(() => props.api.close())}
        />
      )}

      {menu && createPortal(
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
          ariaLabel="Tab actions"
          testId="workspace-tab-context-menu"
          itemTestIdPrefix="tab-ctx"
        />,
        document.body,
      )}
    </div>
  );
}
