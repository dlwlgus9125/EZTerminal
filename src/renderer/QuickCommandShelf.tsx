import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { QuickCommand } from '../shared/quick-command';
import './quick-command-shelf.css';

const LAST_USED_ID_KEY = 'ezterminal.quick-command.last-used-id';

export interface QuickCommandShelfProps {
  readonly commands: readonly QuickCommand[];
  readonly insertDisabledReason?: string;
  readonly runDisabledReason?: string;
  readonly onInsert: (command: string) => void;
  readonly onRun: (command: string) => void;
  readonly onManage: () => void;
}

export function filterQuickCommands(
  commands: readonly QuickCommand[],
  query: string,
): readonly QuickCommand[] {
  const needle = query.trim().normalize('NFC').toLocaleLowerCase();
  if (!needle) return commands;
  return commands.filter((command) => (
    `${command.name}\n${command.description ?? ''}\n${command.command}`
      .normalize('NFC')
      .toLocaleLowerCase()
      .includes(needle)
  ));
}

export function resolvePrimaryQuickCommand(
  commands: readonly QuickCommand[],
  lastUsedId: string | null,
): QuickCommand | null {
  if (commands.length === 0) return null;
  return commands.find((command) => command.id === lastUsedId)
    ?? [...commands].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function readLastUsedId(): string | null {
  try {
    return window.localStorage.getItem(LAST_USED_ID_KEY);
  } catch {
    return null;
  }
}

function rememberLastUsedId(id: string): void {
  try {
    // Persist only an opaque id. Command text remains in the main-owned store.
    window.localStorage.setItem(LAST_USED_ID_KEY, id);
  } catch {
    // A denied/corrupt storage area only removes the convenience ordering.
  }
}

/** Composer-adjacent, explicit Quick Command insertion/run surface. Neither
 * opening the shelf nor selecting a row executes terminal input implicitly. */
export function QuickCommandShelf({
  commands,
  insertDisabledReason,
  runDisabledReason,
  onInsert,
  onRun,
  onManage,
}: QuickCommandShelfProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lastUsedId, setLastUsedId] = useState(readLastUsedId);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const primary = useMemo(
    () => resolvePrimaryQuickCommand(commands, lastUsedId),
    [commands, lastUsedId],
  );
  const visibleCommands = useMemo(
    () => filterQuickCommands(commands, query),
    [commands, query],
  );

  const close = (restoreFocus = true): void => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) requestAnimationFrame(() => toggleRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus());
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (command: QuickCommand, action: 'insert' | 'run'): void => {
    setLastUsedId(command.id);
    rememberLastUsedId(command.id);
    if (action === 'insert') onInsert(command.command);
    else onRun(command.command);
    close(false);
  };

  return (
    <div ref={rootRef} className="quick-command-shelf" data-testid="quick-command-shelf">
      <button
        type="button"
        className="btn quick-command-primary"
        data-testid="quick-command-primary"
        disabled={!primary || Boolean(insertDisabledReason)}
        title={insertDisabledReason ?? (primary ? `Insert: ${primary.name}` : 'No saved Quick Commands')}
        onClick={() => {
          if (primary) choose(primary, 'insert');
        }}
      >
        <span aria-hidden="true">&gt;_</span>
        <span className="quick-command-primary-label">{primary?.name ?? 'Quick'}</span>
      </button>
      <button
        ref={toggleRef}
        type="button"
        className="btn quick-command-toggle"
        data-testid="quick-command-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Browse Quick Commands"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <section
          className="quick-command-popover"
          role="dialog"
          aria-label="Quick Commands"
          data-testid="quick-command-popover"
        >
          <label className="quick-command-search-label">
            <span className="sr-only">Search Quick Commands</span>
            <input
              ref={searchRef}
              className="quick-command-search"
              type="search"
              value={query}
              placeholder="Search commands"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="quick-command-list" aria-live="polite">
            {visibleCommands.length === 0 ? (
              <p className="quick-command-empty">
                {commands.length === 0 ? 'No saved Quick Commands.' : 'No matching commands.'}
              </p>
            ) : visibleCommands.map((command) => (
              <article key={command.id} className="quick-command-row">
                <button
                  type="button"
                  className="quick-command-row-main"
                  data-testid={`quick-command-insert-${command.id}`}
                  disabled={Boolean(insertDisabledReason)}
                  title={insertDisabledReason ?? `Insert ${command.name}`}
                  onClick={() => choose(command, 'insert')}
                >
                  <strong>{command.name}</strong>
                  <code>{command.command}</code>
                  {command.description && <span>{command.description}</span>}
                </button>
                <button
                  type="button"
                  className="btn quick-command-run"
                  data-testid={`quick-command-run-${command.id}`}
                  disabled={Boolean(runDisabledReason)}
                  title={runDisabledReason ?? `Run ${command.name}`}
                  onClick={() => choose(command, 'run')}
                >
                  Run
                </button>
              </article>
            ))}
          </div>

          <button
            type="button"
            className="btn quick-command-manage"
            onClick={() => {
              close(false);
              onManage();
            }}
          >
            Manage Quick Commands…
          </button>
        </section>
      )}
    </div>
  );
}
