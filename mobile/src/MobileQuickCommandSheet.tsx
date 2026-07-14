import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { QuickCommand } from '../../src/shared/quick-command';
import { MobileActionSheet } from './MobileActionSheet';
import type { RemoteQuickCommandsResult } from './transport/ws-ezterminal';

export interface MobileQuickCommandSource {
  listRemoteQuickCommands(): Promise<RemoteQuickCommandsResult>;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

function filterCommands(commands: readonly QuickCommand[], query: string): readonly QuickCommand[] {
  const needle = query.trim().normalize('NFC').toLocaleLowerCase();
  if (!needle) return commands;
  return commands.filter((command) => (
    `${command.name}\n${command.description ?? ''}\n${command.command}`
      .normalize('NFC')
      .toLocaleLowerCase()
      .includes(needle)
  ));
}

/** Capability-gated mobile picker. Command text is held only while the sheet
 * is open and every Run requires a second, explicit preview confirmation. */
export function MobileQuickCommandSheet({
  source,
  supported,
  connected,
  insertDisabledReason,
  runDisabledReason,
  onInsert,
  onRun,
}: {
  readonly source: MobileQuickCommandSource;
  readonly supported: boolean;
  readonly connected: boolean;
  readonly insertDisabledReason?: string;
  readonly runDisabledReason?: string;
  readonly onInsert: (command: string) => void;
  readonly onRun: (command: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [commands, setCommands] = useState<readonly QuickCommand[]>([]);
  const [query, setQuery] = useState('');
  const [confirmCommand, setConfirmCommand] = useState<QuickCommand | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const requestSequenceRef = useRef(0);

  const close = useCallback((): void => {
    requestSequenceRef.current += 1;
    setOpen(false);
    setLoadState('idle');
    setCommands([]);
    setQuery('');
    setConfirmCommand(null);
  }, []);

  const load = useCallback((): void => {
    if (!connected) {
      setLoadState('offline');
      return;
    }
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;
    setLoadState('loading');
    void source.listRemoteQuickCommands().then((result) => {
      if (sequence !== requestSequenceRef.current) return;
      if (result.ok) {
        setCommands(result.commands);
        setLoadState('ready');
      } else {
        setCommands([]);
        setLoadState(result.error === 'offline' ? 'offline' : 'error');
      }
    }).catch(() => {
      if (sequence === requestSequenceRef.current) {
        setCommands([]);
        setLoadState('error');
      }
    });
  }, [connected, source]);

  useEffect(() => {
    if (!open) return;
    load();
  }, [connected, load, open]);

  const visibleCommands = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  if (!supported) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn mobile-quick-command-trigger"
        aria-label="Quick Commands"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="mobile-quick-command-trigger"
        onClick={() => setOpen(true)}
      >
        &gt;_
      </button>

      {open && (
        <MobileActionSheet
          title={confirmCommand ? 'Run Quick Command?' : 'Quick Commands'}
          onClose={close}
          returnFocusRef={triggerRef}
          testId="mobile-quick-command-sheet"
        >
          {confirmCommand ? (
            <>
              <div className="mobile-quick-command-preview">
                <strong>{confirmCommand.name}</strong>
                <code>{confirmCommand.command}</code>
                <p>Run this command in the current session?</p>
              </div>
              <button
                type="button"
                className="mobile-action-sheet-row mobile-quick-command-confirm"
                disabled={!connected || Boolean(runDisabledReason)}
                title={!connected ? 'Offline' : runDisabledReason}
                data-testid="mobile-quick-command-confirm-run"
                onClick={() => {
                  onRun(confirmCommand.command);
                  close();
                }}
              >
                <span className="mobile-action-sheet-row-label">Run command</span>
                {!connected && <span className="mobile-action-sheet-row-state">Offline</span>}
              </button>
              <button
                type="button"
                className="mobile-action-sheet-row"
                onClick={() => setConfirmCommand(null)}
              >
                <span className="mobile-action-sheet-row-label">Back to commands</span>
              </button>
            </>
          ) : (
            <>
              <label className="mobile-quick-command-search-label">
                <span className="sr-only">Search Quick Commands</span>
                <input
                  type="search"
                  className="mobile-quick-command-search"
                  value={query}
                  placeholder="Search commands"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>

              {loadState === 'loading' && <p className="mobile-quick-command-state" role="status">Loading commands…</p>}
              {loadState === 'offline' && (
                <p className="mobile-quick-command-state" role="status">
                  Offline. Reconnect to refresh commands; a command already shown here can still be inserted.
                </p>
              )}
              {loadState === 'error' && (
                <div className="mobile-quick-command-state" role="alert">
                  <p>Could not load Quick Commands.</p>
                  <button type="button" className="btn" onClick={load} disabled={!connected}>Retry</button>
                </div>
              )}
              {loadState === 'ready' && commands.length === 0 && (
                <p className="mobile-quick-command-state">No Quick Commands. Add them on desktop.</p>
              )}
              {loadState === 'ready' && commands.length > 0 && visibleCommands.length === 0 && (
                <p className="mobile-quick-command-state">No matching commands.</p>
              )}

              {visibleCommands.map((command) => (
                <div key={command.id} className="mobile-quick-command-row">
                  <button
                    type="button"
                    className="mobile-quick-command-insert"
                    disabled={Boolean(insertDisabledReason)}
                    title={insertDisabledReason ?? `Insert ${command.name}`}
                    data-testid={`mobile-quick-command-insert-${command.id}`}
                    onClick={() => {
                      onInsert(command.command);
                      close();
                    }}
                  >
                    <strong>{command.name}</strong>
                    <code>{command.command}</code>
                    {command.description && <span>{command.description}</span>}
                  </button>
                  <button
                    type="button"
                    className="btn mobile-quick-command-run"
                    disabled={!connected || Boolean(runDisabledReason)}
                    title={!connected ? 'Offline' : runDisabledReason ?? `Preview and run ${command.name}`}
                    data-testid={`mobile-quick-command-run-${command.id}`}
                    onClick={() => setConfirmCommand(command)}
                  >
                    Run
                  </button>
                </div>
              ))}
            </>
          )}
        </MobileActionSheet>
      )}
    </>
  );
}
