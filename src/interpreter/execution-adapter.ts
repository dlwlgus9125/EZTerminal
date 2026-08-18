/**
 * Internal execution seam.
 *
 * ExecutionSession owns ports, fan-out, replay, control authority, terminal
 * settlement, and teardown ordering. An ActiveExecutionAdapter hides which
 * concrete runner is active and translates only runner-specific controls.
 */

import type { RendererControl } from '../shared/ipc';
import type { BlockHandle } from './block-runner';
import type {
  PipelineData,
  PtyStreamData,
  ScriptStreamData,
  SshForwardCommandData,
  SshStreamData,
} from './core';
import type { PtyAttachHandle, PtySession } from './pty-session';
import type { ScriptSession } from './script-runner';
import type { SshForwardCommandSession } from './ssh-forward-command';
import type { SshSession } from './ssh-session';

export type ActiveExecutionKind = 'structured' | 'pty' | 'script' | 'ssh' | 'forward';

export type ExecutionControlResult = 'handled' | 'unsupported';

/** Keep teardown ownership after transports detach; timers do not hold process exit open. */
const ADAPTER_DISPOSE_RETRY_DELAYS_MS = [
  1_000,
  5_000,
  30_000,
  120_000,
  600_000,
] as const;

export type PagingControl = Extract<
  RendererControl,
  { type: 'requestRows' | 'setViewport' }
>;

export type StructuredPipelineData = Exclude<
  PipelineData,
  PtyStreamData | ScriptStreamData | SshStreamData | SshForwardCommandData
>;

export type LateAttachCapability =
  | { readonly mode: 'shared-frames' }
  | {
      readonly mode: 'pty-replay';
      readonly attach: (onData: (bytes: Uint8Array) => void) => PtyAttachHandle | null;
    }
  | {
      readonly mode: 'unsupported';
      readonly reason: 'ssh-unsupported';
    };

/**
 * The complete interface ExecutionSession needs after a runner starts.
 *
 * Invariants:
 * - lifecycle controls (`cancel`, `close`, `pty-claim-control`) stay outside
 *   this seam and are owned by ExecutionSession;
 * - PTY resize controls have already been authority-gated and clamped;
 * - PTY acks passed here are for the primary port only; mirror pacing remains
 *   on its PtyAttachHandle;
 * - dispose is idempotent even when the concrete runner already settled.
 */
export interface ActiveExecutionAdapter {
  readonly kind: ActiveExecutionKind;
  readonly lateAttach: LateAttachCapability;
  handleControl(control: RendererControl): ExecutionControlResult;
  /** Main-only Agent collaboration seams; available only for a live PTY. */
  readText?(maxLines: number, maxBytes: number): Promise<{
    readonly text: string;
    readonly truncated: boolean;
  } | null>;
  submitText?(text: string): boolean;
  /**
   * The primary port disconnected while attach ports keep the run alive.
   * Only the PTY runner needs this (releases its primary byte-ack window —
   * `PtySession.releasePrimaryWindow`); runners with no primary-keyed pacing
   * omit it. SSH omits it too: late attach is rejected there, so a primary
   * loss is always last-port teardown, never a survivable detach.
   */
  primaryDetached?(): void;
  dispose(): Promise<void>;
}

function retryDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

/**
 * Dispose a detached adapter with bounded background retries. ExecutionSession
 * may clear its active field immediately, but this promise retains the adapter
 * until a later transient Windows sharing lock can be cleaned up.
 */
export async function disposeExecutionAdapterWithRetry(
  adapter: ActiveExecutionAdapter,
  retryDelaysMs: readonly number[] = ADAPTER_DISPOSE_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await adapter.dispose();
      return;
    } catch (error) {
      if (attempt >= retryDelaysMs.length) throw error;
      await retryDelay(Math.max(0, retryDelaysMs[attempt] ?? 0));
    }
  }
}

/**
 * Production supplies the five real runners; contract tests supply fakes at
 * the same seam. Keeping construction here prevents ExecutionSession from
 * growing another nullable field and control branch for every execution kind.
 */
export interface ExecutionAdapterStarters {
  startStructured(data: StructuredPipelineData): BlockHandle;
  startPty(data: PtyStreamData): PtySession;
  startScript(data: ScriptStreamData): ScriptSession;
  startSsh(data: SshStreamData): SshSession;
  startForward(data: SshForwardCommandData): SshForwardCommandSession;
}

interface AdapterDefinition {
  readonly kind: ActiveExecutionKind;
  readonly lateAttach: LateAttachCapability;
  readonly handleControl: (control: RendererControl) => ExecutionControlResult;
  readonly readText?: (maxLines: number, maxBytes: number) => Promise<{
    readonly text: string;
    readonly truncated: boolean;
  } | null>;
  readonly submitText?: (text: string) => boolean;
  readonly primaryDetached?: () => void;
  readonly dispose: () => void | Promise<void>;
}

function activeAdapter(definition: AdapterDefinition): ActiveExecutionAdapter {
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const primaryDetached = definition.primaryDetached;
  const readText = definition.readText;
  const submitText = definition.submitText;
  return {
    kind: definition.kind,
    lateAttach: definition.lateAttach,
    handleControl(control): ExecutionControlResult {
      if (disposed) return 'unsupported';
      return definition.handleControl(control);
    },
    ...(readText
      ? {
          readText(maxLines: number, maxBytes: number) {
            if (disposed) return Promise.resolve(null);
            return readText(maxLines, maxBytes);
          },
        }
      : {}),
    ...(submitText
      ? {
          submitText(text: string): boolean {
            return !disposed && submitText(text);
          },
        }
      : {}),
    ...(primaryDetached
      ? {
          primaryDetached(): void {
            if (disposed) return;
            primaryDetached();
          },
        }
      : {}),
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposed = true;
      try {
        disposePromise = Promise.resolve(definition.dispose());
      } catch (error) {
        disposePromise = Promise.reject(error);
      }
      const operation = disposePromise;
      // A failed physical cleanup (notably a transient Windows sharing
      // violation) must not poison the adapter with a permanently rejected
      // promise. The adapter stays closed to controls, but disposal may retry.
      void operation.catch(() => {
        if (disposePromise === operation) disposePromise = null;
      });
      return operation;
    },
  };
}

function isPagingControl(control: RendererControl): control is PagingControl {
  return control.type === 'requestRows' || control.type === 'setViewport';
}

function structuredAdapter(handle: BlockHandle): ActiveExecutionAdapter {
  return activeAdapter({
    kind: 'structured',
    lateAttach: { mode: 'shared-frames' },
    handleControl(control): ExecutionControlResult {
      if (!isPagingControl(control)) return 'unsupported';
      handle.handleControl(control);
      return 'handled';
    },
    dispose: () => handle.dispose(),
  });
}

function ptyAdapter(session: PtySession): ActiveExecutionAdapter {
  return activeAdapter({
    kind: 'pty',
    lateAttach: {
      mode: 'pty-replay',
      attach: (onData) => session.attach(onData),
    },
    handleControl(control): ExecutionControlResult {
      switch (control.type) {
        case 'pty-input':
          session.write(control.data);
          return 'handled';
        case 'pty-submit-on-ready':
          session.submitOnReady(control.data);
          return 'handled';
        case 'pty-resize':
          session.resize(control.cols, control.rows);
          return 'handled';
        case 'pty-ack':
          session.ack(control.bytes);
          return 'handled';
        default:
          return 'unsupported';
      }
    },
    readText: (maxLines, maxBytes) => session.readText(maxLines, maxBytes),
    submitText: (text) => session.submitText(text),
    primaryDetached: () => session.releasePrimaryWindow(),
    dispose: () => session.dispose(),
  });
}

function scriptAdapter(session: ScriptSession): ActiveExecutionAdapter {
  return activeAdapter({
    kind: 'script',
    lateAttach: { mode: 'shared-frames' },
    handleControl(control): ExecutionControlResult {
      if (!isPagingControl(control)) return 'unsupported';
      session.handleControl(control);
      return 'handled';
    },
    dispose: () => session.dispose(),
  });
}

function sshAdapter(session: SshSession): ActiveExecutionAdapter {
  return activeAdapter({
    kind: 'ssh',
    lateAttach: { mode: 'unsupported', reason: 'ssh-unsupported' },
    handleControl(control): ExecutionControlResult {
      switch (control.type) {
        case 'pty-input':
          session.write(control.data);
          return 'handled';
        case 'pty-resize':
          session.resize(control.cols, control.rows);
          return 'handled';
        case 'pty-ack':
          session.ack(control.bytes);
          return 'handled';
        case 'ssh-prompt-response':
          session.handlePromptResponse(control);
          return 'handled';
        default:
          return 'unsupported';
      }
    },
    dispose: () => session.dispose(),
  });
}

function forwardAdapter(session: SshForwardCommandSession): ActiveExecutionAdapter {
  return activeAdapter({
    kind: 'forward',
    lateAttach: { mode: 'shared-frames' },
    handleControl(control): ExecutionControlResult {
      if (!isPagingControl(control)) return 'unsupported';
      session.handleControl(control);
      return 'handled';
    },
    dispose: () => session.dispose(),
  });
}

export function startExecutionAdapter(
  data: PipelineData,
  starters: ExecutionAdapterStarters,
): ActiveExecutionAdapter {
  switch (data.kind) {
    case 'pty-stream':
      return ptyAdapter(starters.startPty(data));
    case 'script-stream':
      return scriptAdapter(starters.startScript(data));
    case 'ssh-stream':
      return sshAdapter(starters.startSsh(data));
    case 'ssh-forward-command':
      return forwardAdapter(starters.startForward(data));
    default:
      return structuredAdapter(starters.startStructured(data));
  }
}
