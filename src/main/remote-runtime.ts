import type { RemoteRuntimeStatus } from '../shared/ipc';
import type { RemoteBridgeHandle } from './remote-bridge';

export interface RemoteRuntimeControllerOptions {
  readonly port: number;
  readonly readDesiredEnabled: () => Promise<boolean>;
  readonly writeDesiredEnabled: (enabled: boolean) => Promise<void>;
  readonly start: () => Promise<RemoteBridgeHandle>;
  readonly onStatus?: (status: RemoteRuntimeStatus) => void;
  readonly onError?: (error: unknown) => void;
}

export class RemoteRuntimeStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteRuntimeStartError';
    this.code = code;
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'REMOTE_START_FAILED';
}

function publicError(error: unknown, port: number): { readonly errorCode: string; readonly error: string } {
  const code = errorCode(error);
  switch (code) {
    case 'EADDRINUSE':
      return { errorCode: code, error: `Port ${port} is already in use.` };
    case 'EACCES':
      return { errorCode: code, error: `Permission was denied while binding port ${port}.` };
    case 'REMOTE_TOKEN_UNAVAILABLE':
      return { errorCode: code, error: 'The remote access token is unavailable.' };
    case 'REMOTE_SETTINGS_UNAVAILABLE':
      return { errorCode: code, error: 'The remote access setting could not be loaded.' };
    case 'REMOTE_TRUSTED_NETWORK_UNAVAILABLE':
      return { errorCode: code, error: 'No trusted Tailscale, WireGuard, or selected VPN adapter is available.' };
    default:
      return { errorCode: code, error: 'Remote access failed to start.' };
  }
}

/**
 * Serializes the persisted intent and the real listener lifecycle without
 * conflating them. Start failures are status results so the renderer can show
 * a retry affordance while preserving the user's desired setting.
 */
export class RemoteRuntimeController {
  private status: RemoteRuntimeStatus;
  private handle: RemoteBridgeHandle | null = null;
  private lane: Promise<void> = Promise.resolve();
  private initialization: Promise<RemoteRuntimeStatus> | null = null;

  constructor(private readonly options: RemoteRuntimeControllerOptions) {
    this.status = {
      desiredEnabled: false,
      state: 'off',
      port: options.port,
      errorCode: null,
      error: null,
    };
  }

  get currentStatus(): RemoteRuntimeStatus {
    return this.status;
  }

  initialize(): Promise<RemoteRuntimeStatus> {
    if (!this.initialization) {
      this.initialization = this.enqueue(async () => {
        let desiredEnabled: boolean;
        try {
          desiredEnabled = await this.options.readDesiredEnabled();
        } catch (error) {
          this.options.onError?.(error);
          const failure = publicError(
            new RemoteRuntimeStartError('REMOTE_SETTINGS_UNAVAILABLE', 'settings unavailable'),
            this.options.port,
          );
          return this.update({ desiredEnabled: false, state: 'error', ...failure });
        }
        this.update({ desiredEnabled });
        return desiredEnabled ? this.startCore() : this.updateOff();
      });
    }
    return this.initialization;
  }

  async getStatus(): Promise<RemoteRuntimeStatus> {
    await this.initialize();
    return this.status;
  }

  async setDesiredEnabled(enabled: boolean): Promise<RemoteRuntimeStatus> {
    await this.initialize();
    return this.enqueue(async () => {
      try {
        await this.options.writeDesiredEnabled(enabled);
      } catch (error) {
        this.options.onError?.(error);
        const failure = publicError(
          new RemoteRuntimeStartError('REMOTE_SETTINGS_UNAVAILABLE', 'settings unavailable'),
          this.options.port,
        );
        return this.update({ state: 'error', ...failure });
      }
      this.update({ desiredEnabled: enabled, errorCode: null, error: null });
      return enabled ? this.startCore() : this.stopCore();
    });
  }

  async retry(): Promise<RemoteRuntimeStatus> {
    await this.initialize();
    return this.enqueue(async () => {
      if (this.status.desiredEnabled) return this.startCore();
      if (this.handle) return this.stopCore();
      return this.status;
    });
  }

  async stopWithError(code: string, message: string): Promise<RemoteRuntimeStatus> {
    await this.initialize();
    return this.enqueue(async () => {
      try {
        await this.stopHandle();
      } catch (error) {
        this.options.onError?.(error);
      }
      return this.update({ state: 'error', errorCode: code, error: message });
    });
  }

  async shutdown(): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      await this.stopHandle();
      this.update({ state: 'off', errorCode: null, error: null });
      return this.status;
    });
  }

  private async startCore(): Promise<RemoteRuntimeStatus> {
    if (this.handle) {
      return this.update({ state: 'running', port: this.handle.port, errorCode: null, error: null });
    }
    this.update({ state: 'starting', port: this.options.port, errorCode: null, error: null });
    try {
      const handle = await this.options.start();
      this.handle = handle;
      return this.update({ state: 'running', port: handle.port, errorCode: null, error: null });
    } catch (error) {
      this.options.onError?.(error);
      return this.update({ state: 'error', ...publicError(error, this.options.port) });
    }
  }

  private async stopCore(): Promise<RemoteRuntimeStatus> {
    if (!this.handle) return this.updateOff();
    this.update({ state: 'stopping', errorCode: null, error: null });
    try {
      await this.stopHandle();
      return this.updateOff();
    } catch (error) {
      this.options.onError?.(error);
      return this.update({ state: 'error', ...publicError(error, this.options.port) });
    }
  }

  private async stopHandle(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    await handle.stop();
    if (this.handle === handle) this.handle = null;
  }

  private updateOff(): RemoteRuntimeStatus {
    return this.update({ state: 'off', port: this.options.port, errorCode: null, error: null });
  }

  private update(patch: Partial<RemoteRuntimeStatus>): RemoteRuntimeStatus {
    this.status = { ...this.status, ...patch };
    try {
      this.options.onStatus?.(this.status);
    } catch {
      // A renderer notification must never destabilize the listener lifecycle.
    }
    return this.status;
  }

  private enqueue(operation: () => Promise<RemoteRuntimeStatus>): Promise<RemoteRuntimeStatus> {
    const result = this.lane.then(operation, operation);
    this.lane = result.then(() => undefined, () => undefined);
    return result;
  }
}
