import type { MessagePortMain } from 'electron';

import type { InterpreterBroker } from './interpreter-broker';

export interface RunCommandPayload {
  readonly commandText: string;
  readonly runId: string;
  readonly sessionId: string;
}

export interface RunCommandSender {
  postMessage(
    channel: string,
    message: unknown,
    transfer?: MessagePortMain[],
  ): void;
}

export interface RunCommandEvent {
  readonly sender: RunCommandSender;
}

export type RunCommandListener = (event: RunCommandEvent, payload: unknown) => void;

export interface RunCommandIpc {
  on(channel: 'run-command', listener: RunCommandListener): void;
  removeListener(channel: 'run-command', listener: RunCommandListener): void;
}

export interface RunCommandIpcOptions {
  readonly ipc: RunCommandIpc;
  readonly getBroker: () => Pick<InterpreterBroker, 'runCommand'> | null;
  readonly reportError?: (message: string) => void;
  readonly reportInfo?: (message: string) => void;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function isRunCommandPayload(value: unknown): value is RunCommandPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<RunCommandPayload>;
  return (
    typeof candidate.commandText === 'string'
    && isBoundedId(candidate.runId)
    && isBoundedId(candidate.sessionId)
  );
}

/**
 * Owns the app-lifetime run-command IPC listener.
 *
 * BrowserWindow recreation must not add another global ipcMain listener: one
 * renderer request maps to exactly one interpreter run and one port transfer.
 */
export function installRunCommandIpc(options: RunCommandIpcOptions): () => void {
  const reportError = options.reportError ?? ((message: string) => console.error(message));
  const reportInfo = options.reportInfo ?? ((message: string) => console.log(message));
  const listener: RunCommandListener = (event, payload) => {
    if (!isRunCommandPayload(payload)) {
      reportError('[main] rejected malformed run-command payload');
      return;
    }

    const broker = options.getBroker();
    if (!broker) {
      reportError(`[main] interpreter not ready for command: ${payload.commandText}`);
      return;
    }

    const { commandText, runId, sessionId } = payload;
    const port = broker.runCommand(sessionId, runId, commandText);
    if (!port) {
      reportError(`[main] interpreter not ready for command: ${commandText}`);
      return;
    }

    event.sender.postMessage(
      'cmd-port',
      { runId },
      [port as unknown as MessagePortMain],
    );
    reportInfo(`[main] brokered port for run ${runId} in session ${sessionId}`);
  };

  options.ipc.on('run-command', listener);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    options.ipc.removeListener('run-command', listener);
  };
}
