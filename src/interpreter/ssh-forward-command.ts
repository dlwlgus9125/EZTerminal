/** Async runner for the three `ssh-forward-*` builtin markers. */

import { SshForwardError, type SshForwardAction, type SshForwardInfo, type SshForwardResult } from '../shared/ssh-forward';
import { listStreamData, numberValue, recordValue, stringValue, type RecordValue, type SshForwardCommandData } from './core';
import { runBlock, type BlockHandle, type Emit } from './block-runner';

export type RequestSshForward = (request: SshForwardAction, signal: AbortSignal) => Promise<SshForwardResult>;

export interface SshForwardCommandSession {
  handleControl(control: { type: 'requestRows' | 'setViewport'; start: number; count: number }): void;
  dispose(): void;
}

function infoRecord(info: SshForwardInfo): RecordValue {
  return recordValue({
    forwardId: stringValue(info.forwardId),
    connectionId: stringValue(info.connectionId),
    bindHost: stringValue(info.bindHost),
    localPort: numberValue(info.localPort),
    remoteHost: stringValue(info.remoteHost),
    remotePort: numberValue(info.remotePort),
    state: stringValue(info.state),
  });
}

export function runSshForwardCommand(
  data: SshForwardCommandData,
  emit: Emit,
  signal: AbortSignal,
  request: RequestSshForward,
): SshForwardCommandSession {
  let disposed = false;
  let block: BlockHandle | null = null;
  const requestAbort = new AbortController();
  const forwardAbort = (): void => requestAbort.abort();
  if (signal.aborted) requestAbort.abort();
  else signal.addEventListener('abort', forwardAbort, { once: true });

  void request(data.request, requestAbort.signal).then((result) => {
    signal.removeEventListener('abort', forwardAbort);
    if (disposed) return;
    if (signal.aborted) {
      emit({ type: 'cancelled' });
      return;
    }
    if (!result.ok) {
      emit({ type: 'error', message: `ssh-forward: [${result.error.code}] ${result.error.message}` });
      return;
    }
    const rows = (async function* (): AsyncGenerator<RecordValue> {
      for (const info of result.forwards) yield infoRecord(info);
    })();
    block = runBlock(listStreamData(rows, {
      columns: [
        { name: 'forwardId', type: 'string' },
        { name: 'connectionId', type: 'string' },
        { name: 'bindHost', type: 'string' },
        { name: 'localPort', type: 'number' },
        { name: 'remoteHost', type: 'string' },
        { name: 'remotePort', type: 'number' },
        { name: 'state', type: 'string' },
      ],
    }), emit, signal);
  }, (error: unknown) => {
    signal.removeEventListener('abort', forwardAbort);
    if (disposed) return;
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) emit({ type: 'cancelled' });
    else if (error instanceof SshForwardError) emit({ type: 'error', message: `ssh-forward: [${error.code}] ${error.message}` });
    else emit({ type: 'error', message: `ssh-forward: ${error instanceof Error ? error.message : String(error)}` });
  });

  return {
    handleControl(control): void {
      block?.handleControl(control);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      requestAbort.abort();
      signal.removeEventListener('abort', forwardAbort);
      void block?.dispose();
    },
  };
}
