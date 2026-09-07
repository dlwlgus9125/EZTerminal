import type { IpcMain } from 'electron';

export type FeatureIpc = Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;

/** App-lifetime registrations owned by one feature, independent of windows. */
export class IpcRegistration {
  private cleanups: Array<() => void> = [];

  constructor(private readonly ipc: FeatureIpc) { }

  handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): void {
    this.ipc.handle(channel, listener);
    this.cleanups.push(() => this.ipc.removeHandler(channel));
  }

  on(channel: string, listener: Parameters<IpcMain['on']>[1]): void {
    this.ipc.on(channel, listener);
    this.cleanups.push(() => { this.ipc.removeListener(channel, listener); });
  }

  readonly dispose = (): void => {
    const cleanups = this.cleanups;
    this.cleanups = [];
    let failure: unknown;
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  };
}
