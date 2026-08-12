import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { memo, useState, useSyncExternalStore } from 'react';

import { classifyDirectAgentCommand } from '../shared/agent-command';
import type { PtyRestoreWarningFrame } from '../shared/ipc';
import type { BlockController } from './block-controller';
import { formatCwd } from './format-cwd';
import { useAppTranslation } from './i18n';
import { PtyBlock } from './PtyBlock';
import { ResultTable } from './ResultTable';
import { SshPromptCard } from './SshPromptCard';
import { TextBlock } from './TextBlock';
import type { TerminalRuntimeOptions } from './xterm-runtime';
import type { RuntimeLifecycleTier } from '../shared/runtime-lifecycle';
import './runtime-lifecycle.css';

// A Block = command input (the text that was run) + its output, collapsible and
// stacked vertically in the BlockList (`docs/design/terminal-runtime.md`). The output renders
// as a virtualized table (structured) or a text block (scalars), with a per-block
// status indicator (running / done / error / cancelled).

const STATUS_LABEL_KEY = {
  running: 'block.status.running',
  done: 'block.status.done',
  error: 'block.status.error',
  cancelled: 'block.status.cancelled',
} as const;

function restoreWarningKey(warning: PtyRestoreWarningFrame):
  | 'block.restoreSshLateAttach'
  | 'block.restoreQueueOverflow'
  | 'block.restoreRawOutput' {
  if (warning.reason === 'ssh-late-attach-unsupported') {
    return 'block.restoreSshLateAttach';
  }
  if (warning.reason === 'replay-queue-overflow') {
    return 'block.restoreQueueOverflow';
  }
  return 'block.restoreRawOutput';
}

export const Block = memo(function Block({
  controller,
  onDismiss,
  isTakeover = false,
  terminalRuntimeOptions,
  runtimeLifecycleTier = 'active',
}: {
  controller: BlockController;
  onDismiss?: () => void;
  /** This block is the pane's active TUI takeover target (terminal-feel pass
   * T1) — see TerminalPane.tsx's `activeTakeover`. */
  isTakeover?: boolean;
  /** Platform integration for renderer policy and safe external links. */
  terminalRuntimeOptions?: TerminalRuntimeOptions;
  runtimeLifecycleTier?: RuntimeLifecycleTier;
}): JSX.Element {
  const { t } = useAppTranslation();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const isDesktopCodex = terminalRuntimeOptions?.platform === 'desktop'
    && classifyDirectAgentCommand(controller.command) === 'codex';

  const {
    status,
    shape,
    rowCount,
    errorMessage,
    startCwd,
    sshPrompt,
    sshConnectionId,
    sshConnectionState,
    codexRecoveryPending,
  } = snapshot;

  return (
    <section
      className={isTakeover ? 'block block--takeover' : 'block'}
      data-testid="block"
      data-status={status}
      data-runtime-tier={runtimeLifecycleTier}
    >
      <header className="block-head">
        <button
          className="block-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('block.expandOutput') : t('block.collapseOutput')}
          data-testid="block-toggle"
        >
          {collapsed
            ? <ChevronRight aria-hidden="true" size={14} />
            : <ChevronDown aria-hidden="true" size={14} />}
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
        <span
          className={`block-status block-status--${status}`}
          data-status={status}
          data-testid="block-status"
        >
          {status in STATUS_LABEL_KEY
            ? t(STATUS_LABEL_KEY[status as keyof typeof STATUS_LABEL_KEY])
            : status}
        </span>
        {sshConnectionId && sshConnectionState === 'ready' && (
          <button
            type="button"
            className="btn btn-split block-ssh-connection"
            title={t('block.copySshConnectionId', { id: sshConnectionId })}
            onClick={() => void navigator.clipboard.writeText(sshConnectionId)}
            data-testid="block-ssh-connection"
          >
            SSH {sshConnectionId.slice(0, 8)}
          </button>
        )}
        {status === 'running' && isDesktopCodex && (
          <button
            type="button"
            className="btn btn-recover block-recover"
            onClick={() => controller.recoverCodexSession()}
            disabled={codexRecoveryPending}
            title={t('terminalPane.recoverCodexDescription')}
            data-testid="block-codex-recover"
          >
            {codexRecoveryPending
              ? t('terminalPane.recoveringCodex')
              : t('terminalPane.recoverCodex')}
          </button>
        )}
        {status === 'running' && (
          <button
            type="button"
            className="btn btn-cancel block-cancel"
            onClick={() => controller.cancel()}
            data-testid="block-cancel"
          >
            {isDesktopCodex ? t('terminalPane.forceStop') : t('common.cancel')}
          </button>
        )}
        {onDismiss && (
          <button
            className="btn block-dismiss"
            onClick={onDismiss}
            aria-label={t('block.dismiss')}
            data-testid="block-dismiss"
          >
            <X aria-hidden="true" size={16} />
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
              {t(restoreWarningKey(snapshot.ptyRestoreWarning))}
            </div>
          )}
          {sshPrompt ? (
            <SshPromptCard controller={controller} prompt={sshPrompt} />
          ) : status === 'error' ? (
            <pre className="text-block text-block--error" data-testid="block-error">
              {errorMessage ?? t('block.status.error')}
            </pre>
          ) : runtimeLifecycleTier === 'parked' && shape !== 'pty' ? (
            <div className="block-presentation-parked" data-testid="block-presentation-parked" />
          ) : shape === 'text' ? (
            <TextBlock controller={controller} />
          ) : shape === 'table' ? (
            <ResultTable controller={controller} />
          ) : shape === 'pty' ? (
            <PtyBlock
              controller={controller}
              runtimeOptions={terminalRuntimeOptions}
              runtimeLifecycleTier={runtimeLifecycleTier}
            />
          ) : (
            <div className="block-pending">{t('block.running')}</div>
          )}
        </div>
      )}
    </section>
  );
});
