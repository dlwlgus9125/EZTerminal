import { useState, useSyncExternalStore } from 'react';

import type { BlockController } from './block-controller';
import { formatCwd } from './format-cwd';
import { PtyBlock } from './PtyBlock';
import { ResultTable } from './ResultTable';
import { SshPromptCard } from './SshPromptCard';
import { TextBlock } from './TextBlock';
import type { TerminalRuntimeOptions } from './xterm-runtime';
import type { PtyRestoreWarningFrame } from '../shared/ipc';

// A Block = command input (the text that was run) + its output, collapsible and
// stacked vertically in the BlockList (architecture §8 item 9). The output renders
// as a virtualized table (structured) or a text block (scalars), with a per-block
// status indicator (running / done / error / cancelled).

const STATUS_LABEL: Record<string, string> = {
  running: 'running',
  done: 'done',
  error: 'error',
  cancelled: 'cancelled',
};

function restoreWarningMessage(warning: PtyRestoreWarningFrame): string {
  if (warning.reason === 'ssh-late-attach-unsupported') {
    return 'This SSH terminal cannot be restored on a late-attached device. The original session is still running.';
  }
  if (warning.reason === 'replay-queue-overflow') {
    return 'Terminal restore could not keep up with live output. Reconnect this session to try again.';
  }
  return 'Exact terminal state was unavailable; recent raw output was restored.';
}

export function Block({
  controller,
  onDismiss,
  isTakeover = false,
  terminalRuntimeOptions,
}: {
  controller: BlockController;
  onDismiss?: () => void;
  /** This block is the pane's active TUI takeover target (terminal-feel pass
   * T1) — see TerminalPane.tsx's `activeTakeover`. */
  isTakeover?: boolean;
  /** Platform integration for renderer policy and safe external links. */
  terminalRuntimeOptions?: TerminalRuntimeOptions;
}): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [collapsed, setCollapsed] = useState(false);

  const { status, shape, rowCount, errorMessage, startCwd, sshPrompt, sshConnectionId, sshConnectionState } = snapshot;

  return (
    <section
      className={isTakeover ? 'block block--takeover' : 'block'}
      data-testid="block"
      data-status={status}
    >
      <header className="block-head">
        <button
          className="block-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'expand output' : 'collapse output'}
          data-testid="block-toggle"
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {startCwd && (
          <span className="block-cwd" title={startCwd} data-testid="block-cwd">
            {formatCwd(startCwd)}
          </span>
        )}
        <span className="prompt-sigil" aria-hidden="true">
          ❯
        </span>
        <code className="block-command" data-testid="block-command">
          {controller.command}
        </code>
        {shape === 'table' && (
          <span className="block-count" data-testid="row-count">
            {rowCount}
          </span>
        )}
        <span className={`block-status block-status--${status}`} data-testid="block-status">
          {STATUS_LABEL[status] ?? status}
        </span>
        {sshConnectionId && sshConnectionState === 'ready' && (
          <button
            type="button"
            className="btn btn-split block-ssh-connection"
            title={`Copy SSH connection id ${sshConnectionId}`}
            onClick={() => void navigator.clipboard.writeText(sshConnectionId)}
            data-testid="block-ssh-connection"
          >
            SSH {sshConnectionId.slice(0, 8)}
          </button>
        )}
        {status === 'running' && (
          <button
            className="btn btn-cancel block-cancel"
            onClick={() => controller.cancel()}
            data-testid="block-cancel"
          >
            Cancel
          </button>
        )}
        {onDismiss && (
          <button
            className="btn block-dismiss"
            onClick={onDismiss}
            aria-label="dismiss block"
            data-testid="block-dismiss"
          >
            ✕
          </button>
        )}
      </header>

      {/* A PTY block stays MOUNTED while collapsed (hidden via CSS) so collapsing
          never disposes the xterm or drops live output (B3); other shapes unmount
          on collapse as before. */}
      {(!collapsed || (shape === 'pty' && status !== 'error')) && (
        <div className="block-body" data-testid="block-body" hidden={collapsed}>
          {snapshot.ptyRestoreWarning && (
            <div
              className="pty-restore-warning"
              role="status"
              data-testid="pty-restore-warning"
              data-reason={snapshot.ptyRestoreWarning.reason}
            >
              {restoreWarningMessage(snapshot.ptyRestoreWarning)}
            </div>
          )}
          {sshPrompt ? (
            <SshPromptCard controller={controller} prompt={sshPrompt} />
          ) : status === 'error' ? (
            <pre className="text-block text-block--error" data-testid="block-error">
              {errorMessage ?? 'error'}
            </pre>
          ) : shape === 'text' ? (
            <TextBlock controller={controller} />
          ) : shape === 'table' ? (
            <ResultTable controller={controller} />
          ) : shape === 'pty' ? (
            <PtyBlock controller={controller} runtimeOptions={terminalRuntimeOptions} />
          ) : (
            <div className="block-pending">running…</div>
          )}
        </div>
      )}
    </section>
  );
}
