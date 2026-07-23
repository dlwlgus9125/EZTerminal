import type {
  RemoteConnectionInfo,
  RemoteDesktopHostStatus,
  RemoteRuntimeStatus,
} from '../shared/ipc';
import type { DesktopControlEndedMessage } from '../shared/remote-protocol';
import type { RemoteBridgeHandle } from './remote-bridge';
import { RemoteRuntimeController, RemoteRuntimeStartError } from './remote-runtime';

export const DESKTOP_RUNTIME_IPC_CHANNELS = [
  'remote:get-connection-info',
  'remote:get-token',
  'remote:get-security-status',
  'remote:rotate-token',
  'remote:get-enabled',
  'remote:get-runtime-status',
  'remote:set-enabled',
  'remote:retry-runtime',
  'remote:get-desktop-status',
  'remote:disconnect-desktop',
] as const;

export type DesktopRuntimeIpcChannel = (typeof DESKTOP_RUNTIME_IPC_CHANNELS)[number];
export type DesktopRuntimeIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

/** Electron's ipcMain surface reduced to the registration lifecycle this Module owns. */
export interface DesktopRuntimeIpcAdapter {
  handle(channel: DesktopRuntimeIpcChannel, handler: DesktopRuntimeIpcHandler): void;
  removeHandler(channel: DesktopRuntimeIpcChannel): void;
}

/** Secure token persistence seam. Production uses RemoteTokenStore; tests use memory. */
export interface DesktopRuntimeTokenStore {
  init(): Promise<void>;
  getToken(): Promise<string>;
  rotateToken(): Promise<string>;
}

/** The desktop-control host behavior needed by the runtime lifecycle. */
export interface DesktopControlHost {
  getStatus(): RemoteDesktopHostStatus;
  probeService(): Promise<RemoteDesktopHostStatus>;
  onStatus(listener: (status: RemoteDesktopHostStatus) => void): () => void;
  shutdown(reason: DesktopControlEndedMessage['reason']): Promise<void>;
}

/** Optional local presentation of desktop-control status (the Windows tray Adapter). */
export interface DesktopStatusPresentation {
  update(status: RemoteDesktopHostStatus): void;
  destroy(): void;
}

export interface DesktopRuntimeOptions {
  readonly port: number;
  readonly ipc: DesktopRuntimeIpcAdapter;
  readonly tokenStore: DesktopRuntimeTokenStore;
  readonly desktopHost: DesktopControlHost;
  readonly desktopPresentation?: DesktopStatusPresentation;
  readonly readDesiredEnabled: () => Promise<boolean>;
  readonly writeDesiredEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Starts the authenticated bridge. Token security has already succeeded and
   * disposal is checked immediately before this function is called.
   */
  readonly startBridge: () => Promise<RemoteBridgeHandle>;
  readonly getConnectionInfo: () => RemoteConnectionInfo;
  readonly stopAuxiliaryRuntime: () => Promise<void>;
  readonly publishRuntimeStatus: (status: RemoteRuntimeStatus) => void;
  readonly publishDesktopStatus: (status: RemoteDesktopHostStatus) => void;
  readonly reportError?: (context: string, error: unknown) => void;
}

/**
 * Deep Interface over remote listener + desktop-control lifecycle.
 *
 * initialize() and dispose() are idempotent. dispose() removes IPC handlers
 * and status listeners synchronously before awaiting resource shutdown, so
 * late async completions cannot publish stale state. A disposed instance
 * cannot be initialized again.
 */
export interface DesktopRuntime {
  initialize(): Promise<RemoteRuntimeStatus>;
  isRunning(): boolean;
  dispose(): Promise<void>;
}

type RuntimePhase = 'new' | 'active' | 'disposing' | 'disposed';

const TOKEN_UNAVAILABLE_MESSAGE =
  'The remote access token could not be stored securely. Remote access remains off.';
const TOKEN_ROTATION_FAILED_MESSAGE =
  'The new remote access token could not be stored securely. Remote access was stopped.';
const SAFE_DIAGNOSTIC_ERROR_NAMES = new Set([
  'AggregateError',
  'Error',
  'RangeError',
  'RemoteRuntimeStartError',
  'TypeError',
]);
const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  'EACCES',
  'EADDRINUSE',
  'EIO',
  'ENOENT',
  'EPERM',
  'ETIMEDOUT',
  'REMOTE_RUNTIME_DISPOSED',
  'REMOTE_SETTINGS_UNAVAILABLE',
  'REMOTE_START_FAILED',
  'REMOTE_STOP_FAILED',
  'REMOTE_TOKEN_UNAVAILABLE',
  'REMOTE_TRUSTED_NETWORK_UNAVAILABLE',
]);

/**
 * Produces a diagnostic label without including Error.message, stack traces,
 * bearer tokens, paths, native payloads, or arbitrary object serialization.
 */
export function describeDesktopRuntimeError(error: unknown): string {
  const safeName = (
    error instanceof Error
    && SAFE_DIAGNOSTIC_ERROR_NAMES.has(error.name)
  )
    ? error.name
    : 'UnknownError';
  const code = (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && SAFE_DIAGNOSTIC_ERROR_CODES.has(error.code)
  )
    ? error.code
    : null;
  return code ? `${safeName} (${code})` : safeName;
}

export class ManagedDesktopRuntime implements DesktopRuntime {
  private readonly runtime: RemoteRuntimeController;
  private phase: RuntimePhase = 'new';
  private generation = 0;
  private initialization: Promise<RemoteRuntimeStatus> | null = null;
  private disposal: Promise<void> | null = null;
  private tokenSecure = false;
  private tokenError: string | null = null;
  private tokenInitialization: Promise<void> | null = null;
  private desktopStatusUnsubscribe: (() => void) | null = null;
  private readonly installedChannels: DesktopRuntimeIpcChannel[] = [];

  constructor(private readonly options: DesktopRuntimeOptions) {
    this.runtime = new RemoteRuntimeController({
      port: options.port,
      readDesiredEnabled: options.readDesiredEnabled,
      writeDesiredEnabled: options.writeDesiredEnabled,
      start: () => this.startBridge(),
      onStatus: (status) => this.publishRuntimeStatus(status),
      onError: (error) => this.reportError('remote runtime operation failed', error),
    });
  }

  initialize(): Promise<RemoteRuntimeStatus> {
    if (this.initialization) return this.initialization;
    if (this.phase === 'disposing' || this.phase === 'disposed') {
      return Promise.reject(new Error('DesktopRuntime is disposed.'));
    }

    this.phase = 'active';
    const generation = ++this.generation;
    try {
      this.registerIpcHandlers(generation);
      this.desktopStatusUnsubscribe = this.options.desktopHost.onStatus((status) => {
        if (!this.isActiveGeneration(generation)) return;
        this.publishDesktopStatus(status);
        this.updateDesktopPresentation(status);
      });
      this.updateDesktopPresentation(this.options.desktopHost.getStatus());
    } catch (error) {
      this.phase = 'new';
      ++this.generation;
      this.unregisterIpcHandlers();
      this.unsubscribeDesktopStatus();
      this.reportError('desktop runtime registration failed', error);
      return Promise.reject(error);
    }

    void this.options.desktopHost.probeService().catch((error) => {
      if (this.isActiveGeneration(generation)) {
        this.reportError('remote desktop service probe failed', error);
      }
    });

    this.initialization = this.runtime.initialize();
    return this.initialization;
  }

  isRunning(): boolean {
    return this.phase === 'active' && this.runtime.currentStatus.state === 'running';
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;

    const runtimeWasInitialized = this.initialization !== null;
    this.phase = 'disposing';
    ++this.generation;
    this.unregisterIpcHandlers();
    this.unsubscribeDesktopStatus();

    this.disposal = this.disposeResources(runtimeWasInitialized);
    return this.disposal;
  }

  private async disposeResources(runtimeWasInitialized: boolean): Promise<void> {
    try {
      if (runtimeWasInitialized) {
        await this.settleCleanup('remote runtime shutdown failed', () => this.runtime.shutdown());
      }
      await this.settleCleanup(
        'remote desktop shutdown failed',
        () => this.options.desktopHost.shutdown('app-quit'),
      );
      await this.settleCleanup('auxiliary remote runtime shutdown failed', this.options.stopAuxiliaryRuntime);
      try {
        this.options.desktopPresentation?.destroy();
      } catch (error) {
        this.reportError('remote desktop presentation cleanup failed', error);
      }
    } finally {
      this.phase = 'disposed';
    }
  }

  private registerIpcHandlers(generation: number): void {
    const guard = (handler: DesktopRuntimeIpcHandler): DesktopRuntimeIpcHandler =>
      (event, ...args) => {
        if (!this.isActiveGeneration(generation)) {
          throw new Error('DesktopRuntime is unavailable.');
        }
        return handler(event, ...args);
      };

    const handlers: readonly (readonly [DesktopRuntimeIpcChannel, DesktopRuntimeIpcHandler])[] = [
      ['remote:get-connection-info', guard(() => this.options.getConnectionInfo())],
      ['remote:get-token', guard(async () => {
        await this.ensureTokenSecurity();
        return this.options.tokenStore.getToken();
      })],
      ['remote:get-security-status', guard(async () => {
        try {
          await this.ensureTokenSecurity();
        } catch {
          // The renderer-safe status payload below is the public error channel.
        }
        return {
          state: this.tokenError === null ? 'ready' : 'error',
          error: this.tokenError,
        } as const;
      })],
      ['remote:rotate-token', guard(() => this.rotateToken())],
      ['remote:get-enabled', guard(async () => (await this.runtime.getStatus()).desiredEnabled)],
      ['remote:get-runtime-status', guard(() => this.runtime.getStatus())],
      ['remote:set-enabled', guard((_event, enabled) => this.setEnabled(enabled))],
      ['remote:retry-runtime', guard(() => this.runtime.retry())],
      ['remote:get-desktop-status', guard(() => this.options.desktopHost.probeService())],
      ['remote:disconnect-desktop', guard(() => this.disconnectDesktop())],
    ];

    for (const [channel, handler] of handlers) {
      this.options.ipc.handle(channel, handler);
      this.installedChannels.push(channel);
    }
  }

  private unregisterIpcHandlers(): void {
    for (let index = this.installedChannels.length - 1; index >= 0; index -= 1) {
      const channel = this.installedChannels[index];
      try {
        this.options.ipc.removeHandler(channel);
      } catch (error) {
        this.reportError('desktop runtime IPC cleanup failed', error);
      }
    }
    this.installedChannels.length = 0;
  }

  private unsubscribeDesktopStatus(): void {
    const unsubscribe = this.desktopStatusUnsubscribe;
    this.desktopStatusUnsubscribe = null;
    if (!unsubscribe) return;
    try {
      unsubscribe();
    } catch (error) {
      this.reportError('remote desktop status cleanup failed', error);
    }
  }

  private async ensureTokenSecurity(): Promise<void> {
    if (this.tokenSecure) return;
    if (!this.tokenInitialization) {
      this.tokenInitialization = (async () => {
        await this.options.tokenStore.init();
        // Load or mint before any network listener can bind.
        await this.options.tokenStore.getToken();
        this.tokenSecure = true;
        this.tokenError = null;
      })()
        .catch((error) => {
          this.tokenSecure = false;
          this.tokenError = TOKEN_UNAVAILABLE_MESSAGE;
          this.reportError('remote token security readiness failed', error);
          throw error;
        })
        .finally(() => {
          this.tokenInitialization = null;
        });
    }
    await this.tokenInitialization;
  }

  private async startBridge(): Promise<RemoteBridgeHandle> {
    try {
      await this.ensureTokenSecurity();
    } catch {
      throw new RemoteRuntimeStartError('REMOTE_TOKEN_UNAVAILABLE', 'remote token unavailable');
    }
    if (this.phase !== 'active') {
      throw new RemoteRuntimeStartError('REMOTE_RUNTIME_DISPOSED', 'remote runtime disposed');
    }
    return this.options.startBridge();
  }

  private async rotateToken(): Promise<string> {
    await this.ensureTokenSecurity();
    try {
      const token = await this.options.tokenStore.rotateToken();
      await this.options.desktopHost.shutdown('token-rotated');
      return token;
    } catch (error) {
      this.tokenSecure = false;
      this.tokenError = TOKEN_ROTATION_FAILED_MESSAGE;
      await this.runtime.stopWithError('REMOTE_TOKEN_UNAVAILABLE', this.tokenError);
      await this.safeStopAuxiliaryRuntime();
      throw error;
    }
  }

  private async setEnabled(enabled: unknown): Promise<RemoteRuntimeStatus> {
    if (typeof enabled !== 'boolean') return this.runtime.getStatus();
    const status = await this.runtime.setDesiredEnabled(enabled);
    if (!enabled) await this.safeStopAuxiliaryRuntime();
    return status;
  }

  private async disconnectDesktop(): Promise<boolean> {
    const active = this.options.desktopHost.getStatus().controllerName !== null;
    if (active) await this.options.desktopHost.shutdown('local-disconnect');
    return active;
  }

  private async safeStopAuxiliaryRuntime(): Promise<void> {
    try {
      await this.options.stopAuxiliaryRuntime();
    } catch (error) {
      this.reportError('auxiliary remote runtime shutdown failed', error);
    }
  }

  private async settleCleanup(context: string, cleanup: () => Promise<void>): Promise<void> {
    try {
      await cleanup();
    } catch (error) {
      this.reportError(context, error);
    }
  }

  private publishRuntimeStatus(status: RemoteRuntimeStatus): void {
    if (this.phase !== 'active') return;
    try {
      this.options.publishRuntimeStatus(status);
    } catch (error) {
      this.reportError('remote runtime status publication failed', error);
    }
  }

  private publishDesktopStatus(status: RemoteDesktopHostStatus): void {
    try {
      this.options.publishDesktopStatus(status);
    } catch (error) {
      this.reportError('remote desktop status publication failed', error);
    }
  }

  private updateDesktopPresentation(status: RemoteDesktopHostStatus): void {
    try {
      this.options.desktopPresentation?.update(status);
    } catch (error) {
      this.reportError('remote desktop presentation update failed', error);
    }
  }

  private isActiveGeneration(generation: number): boolean {
    return this.phase === 'active' && this.generation === generation;
  }

  private reportError(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics must never destabilize the runtime lifecycle.
    }
  }
}
