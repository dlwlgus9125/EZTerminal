import type { IpcMainInvokeEvent } from 'electron';
import type { LocalMutationIngress } from './local-mutation-ingress';

export const gateLocalMutation = <TArgs extends unknown[], TResult>(
  ingress: LocalMutationIngress,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | PromiseLike<TResult>,
) => (
  event: IpcMainInvokeEvent,
  ...args: TArgs
): Promise<TResult> => ingress.run(() => handler(event, ...args));
export const gateAbortableLocalMutation = <TArgs extends unknown[], TResult>(
  ingress: LocalMutationIngress,
  handler: (
    signal: AbortSignal,
    event: IpcMainInvokeEvent,
    ...args: TArgs
  ) => TResult | PromiseLike<TResult>,
) => (
  event: IpcMainInvokeEvent,
  ...args: TArgs
): Promise<TResult> => ingress.run((signal) => handler(signal, event, ...args));
