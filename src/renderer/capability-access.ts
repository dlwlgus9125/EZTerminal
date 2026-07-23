import type {
  AgentIntegrationMutationResult,
  AgentIntegrationProvider,
  AgentIntegrationStatus,
  AgentSettings,
} from '../shared/agent';
import type { FilePreviewResult } from '../shared/file-preview';
import type { FileListResult, FileOpResult } from '../shared/files';
import type {
  EzTerminalApi,
  EzTerminalDesktopApi,
  RemoteConnectionInfo,
  RemoteDesktopHostStatus,
  RemoteRuntimeStatus,
  RemoteSecurityStatus,
  SystemStatsSnapshot,
} from '../shared/ipc';
import type { OpenClawMode } from '../shared/layout-schema';
import type {
  OpenClawAgentSession,
  OpenClawAutostartAction,
  OpenClawAutostartResult,
  OpenClawChatBounds,
  OpenClawChatViewState,
  OpenClawConfigKey,
  OpenClawCoreConfig,
  OpenClawLifecycleAction,
  OpenClawLifecycleResult,
  OpenClawLogLine,
  OpenClawSetConfigResult,
  OpenClawStatus,
  OpenClawVisibility,
} from '../shared/openclaw';
import type { SshForwardInfo, SshForwardResult } from '../shared/ssh-forward';
import type { UiPreferences, UiPreferencesPatch } from '../shared/ui-preferences';

export type CapabilityAvailability = 'available' | 'unavailable';
export type CapabilityCleanup = () => void;

export interface CapabilitySnapshot {
  readonly core: CapabilityAvailability;
  readonly desktop: CapabilityAvailability;
}

/**
 * Production reads from the preload-owned globals. Tests inject an in-memory
 * source at the same Seam, so callers and tests exercise the same Interface.
 */
export interface CapabilitySource {
  readonly readCore: () => EzTerminalApi | undefined;
  readonly readDesktop: () => EzTerminalDesktopApi | undefined;
}

export class RequiredCapabilityUnavailableError extends Error {
  constructor(readonly operation: keyof EzTerminalApi | 'versions') {
    super(`Required renderer capability is unavailable: core.${String(operation)}`);
    this.name = 'RequiredCapabilityUnavailableError';
  }
}

export interface AgentIntegrationAccess {
  load: () => Promise<{
    readonly integrations: readonly AgentIntegrationStatus[];
    readonly settings: AgentSettings;
  } | null>;
  setEnabled: (
    provider: AgentIntegrationProvider,
    enabled: boolean,
  ) => Promise<AgentIntegrationMutationResult | null>;
  saveSettings: (settings: AgentSettings) => Promise<AgentSettings | null>;
}

export interface OpenClawDrawerObserver {
  readonly onStatus: (status: OpenClawStatus) => void;
  readonly onLog: (line: OpenClawLogLine) => void;
  readonly onError?: (error: unknown) => void;
}

export interface OpenClawChatObserver {
  readonly onStatus: (status: OpenClawStatus) => void;
  readonly onViewState: (state: OpenClawChatViewState) => void;
  readonly onError?: (error: unknown) => void;
}

export interface OpenClawAccess {
  observeDrawer: (observer: OpenClawDrawerObserver) => CapabilityCleanup;
  observeChat: (observer: OpenClawChatObserver) => CapabilityCleanup;
  observeVisibility: (
    onVisibility: (visibility: OpenClawVisibility) => void,
    onError?: (error: unknown) => void,
  ) => CapabilityCleanup;
  getStatus: (force?: boolean) => Promise<OpenClawStatus | null>;
  runLifecycle: (action: OpenClawLifecycleAction) => Promise<OpenClawLifecycleResult | null>;
  runAutostart: (action: OpenClawAutostartAction) => Promise<OpenClawAutostartResult | null>;
  listSessions: () => Promise<readonly OpenClawAgentSession[] | null>;
  getConfig: () => Promise<OpenClawCoreConfig | null>;
  setConfig: (key: OpenClawConfigKey, value: string) => Promise<OpenClawSetConfigResult | null>;
  getMode: () => Promise<OpenClawMode | null>;
  setMode: (mode: OpenClawMode) => Promise<boolean>;
  setChatVisible: (visible: boolean) => boolean;
  openChat: () => boolean;
  closeChat: () => boolean;
  reloadChat: () => boolean;
  setChatBounds: (bounds: OpenClawChatBounds) => boolean;
  openChatExternal: () => Promise<boolean>;
}

export interface RemoteDesktopAccess {
  observe: (
    onStatus: (status: RemoteDesktopHostStatus) => void,
    onError?: (error: unknown) => void,
  ) => CapabilityCleanup;
  disconnect: () => Promise<boolean | null>;
}

export interface RemoteRuntimeObserver {
  readonly onStatus: (status: RemoteRuntimeStatus) => void;
  readonly onSecurity: (status: RemoteSecurityStatus) => void;
  readonly onError?: (error: unknown) => void;
}

export interface RemoteRuntimeAccess {
  observe: (observer: RemoteRuntimeObserver) => CapabilityCleanup;
  setEnabled: (enabled: boolean) => Promise<RemoteRuntimeStatus>;
  retry: () => Promise<RemoteRuntimeStatus>;
}

export type RemotePairingStage = 'connection' | 'security' | 'token' | 'runtime';

export interface RemotePairingObserver {
  readonly onConnectionInfo: (info: RemoteConnectionInfo) => void;
  readonly onSecurity: (status: RemoteSecurityStatus) => void;
  readonly onToken: (token: string) => void;
  readonly onRuntime: (status: RemoteRuntimeStatus) => void;
  readonly onError?: (stage: RemotePairingStage, error: unknown) => void;
}

export interface RemotePairingAccess {
  observe: (observer: RemotePairingObserver) => CapabilityCleanup;
  rotateToken: () => Promise<string>;
}

export interface SystemStatusObserver {
  readonly onSeed: (history: readonly SystemStatsSnapshot[]) => void;
  readonly onSnapshot: (snapshot: SystemStatsSnapshot) => void;
  readonly onError?: (error: unknown) => void;
}

export interface SystemStatusAccess {
  observe: (observer: SystemStatusObserver) => CapabilityCleanup;
  capturePackets: (onError?: (error: unknown) => void) => CapabilityCleanup;
}

export interface SshForwardAccess {
  list: () => Promise<readonly SshForwardInfo[] | null>;
  stop: (connectionId: string, forwardId: string) => Promise<SshForwardResult | null>;
}

export interface UiPreferenceAccess {
  load: () => Promise<UiPreferences | null>;
  save: (patch: UiPreferencesPatch) => Promise<UiPreferences | null>;
  refreshNativeMenuLocale: () => Promise<boolean>;
}

export interface FileAccess {
  list: (path: string) => Promise<FileListResult>;
  listRoots: () => Promise<string[]>;
  preview: (path: string) => Promise<FilePreviewResult>;
  createFolder: (path: string, name: string) => Promise<FileOpResult>;
  rename: (path: string, name: string) => Promise<FileOpResult>;
  trash: (path: string) => Promise<FileOpResult>;
  openInApp: (path: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  pathForDrop: (file: File) => string | null;
  openExternalHttpUrl: (url: string) => Promise<boolean>;
}

export interface CapabilityAccess {
  /**
   * Probes without throwing. A missing desktop bridge is not cached, so a
   * later call can explicitly observe preload becoming available.
   */
  snapshot: () => CapabilitySnapshot;
  runtimeVersions: () => EzTerminalApi['versions'] | null;
  readonly agentIntegrations: AgentIntegrationAccess;
  readonly openClaw: OpenClawAccess;
  readonly remoteDesktop: RemoteDesktopAccess;
  readonly remotePairing: RemotePairingAccess;
  readonly remoteRuntime: RemoteRuntimeAccess;
  readonly systemStatus: SystemStatusAccess;
  readonly sshForwards: SshForwardAccess;
  readonly uiPreferences: UiPreferenceAccess;
  readonly files: FileAccess;
}

const NOOP_CLEANUP: CapabilityCleanup = () => undefined;

function onceCleanup(cleanups: readonly CapabilityCleanup[]): CapabilityCleanup {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of [...cleanups].reverse()) {
      try {
        cleanup();
      } catch {
        // Cleanup must remain best-effort and must not strand later cleanups.
      }
    }
  };
}

interface SeedPushGate<TSeed, TPush> {
  /**
   * Delivers a level-triggered seed only if no push arrived after the seed
   * request began. This generation rule prevents late IPC replies from
   * reverting newer edge-triggered state.
   */
  seed(start: () => Promise<TSeed>): void;
  push(value: TPush): void;
  load<T>(
    start: () => Promise<T>,
    onValue: (value: T) => void,
    onLoadError?: (error: unknown) => void,
  ): void;
  event(deliver: () => void): void;
  stop(): void;
}

function createSeedPushGate<TSeed, TPush>(
  onSeed: (value: TSeed) => void,
  onPush: (value: TPush) => void,
  onError?: (error: unknown) => void,
): SeedPushGate<TSeed, TPush> {
  let active = true;
  let pushGeneration = 0;

  const report = (error: unknown): void => {
    if (!active) return;
    try {
      onError?.(error);
    } catch {
      // Observer error handlers must not destabilize the renderer.
    }
  };
  const invoke = (
    deliver: () => void,
    onDeliveryError: (error: unknown) => void = report,
  ): void => {
    if (!active) return;
    try {
      deliver();
    } catch (error) {
      try {
        onDeliveryError(error);
      } catch {
        // A consumer-owned error callback must not escape the capability Seam.
      }
    }
  };
  const load = <T,>(
    start: () => Promise<T>,
    onValue: (value: T) => void,
    onLoadError: (error: unknown) => void = report,
  ): void => {
    const fail = (error: unknown): void => {
      if (!active) return;
      try {
        onLoadError(error);
      } catch {
        // A consumer-owned error callback must not escape the capability Seam.
      }
    };
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      fail(error);
      return;
    }
    void promise.then(
      (value) => invoke(() => onValue(value), fail),
      fail,
    );
  };

  return {
    seed(start): void {
      const expectedGeneration = pushGeneration;
      load(start, (value) => {
        if (pushGeneration === expectedGeneration) onSeed(value);
      });
    },
    push(value): void {
      if (!active) return;
      pushGeneration += 1;
      invoke(() => onPush(value));
    },
    load,
    event: invoke,
    stop(): void {
      active = false;
    },
  };
}

export function createCapabilityAccess(source: CapabilitySource): CapabilityAccess {
  let core: EzTerminalApi | undefined;
  let desktop: EzTerminalDesktopApi | undefined;

  const resolveCore = (): EzTerminalApi | undefined => {
    core ??= source.readCore();
    return core;
  };

  // Optional desktop may be absent during early renderer startup. Absence is
  // deliberately not memoized; the first available bridge is then stable.
  const resolveDesktop = (): EzTerminalDesktopApi | undefined => {
    desktop ??= source.readDesktop();
    return desktop;
  };

  const requireCore = (operation: keyof EzTerminalApi | 'versions'): EzTerminalApi => {
    const api = resolveCore();
    if (!api || (operation !== 'versions' && typeof api[operation] !== 'function')) {
      throw new RequiredCapabilityUnavailableError(operation);
    }
    return api;
  };

  const desktopFor = (operation: keyof EzTerminalDesktopApi): EzTerminalDesktopApi | undefined => {
    const api = resolveDesktop();
    return api && typeof api[operation] === 'function' ? api : undefined;
  };

  const agentIntegrations: AgentIntegrationAccess = {
    async load() {
      const api = desktopFor('listAgentIntegrations');
      if (!api || typeof api.getAgentSettings !== 'function') return null;
      const [integrations, settings] = await Promise.all([
        api.listAgentIntegrations(),
        api.getAgentSettings(),
      ]);
      return { integrations, settings };
    },
    async setEnabled(provider, enabled) {
      const api = desktopFor('setAgentIntegrationEnabled');
      return api ? api.setAgentIntegrationEnabled(provider, enabled) : null;
    },
    async saveSettings(settings) {
      const api = desktopFor('setAgentSettings');
      return api ? api.setAgentSettings(settings) : null;
    },
  };

  const openClaw: OpenClawAccess = {
    observeDrawer(observer) {
      const api = desktopFor('getOpenClawStatus');
      if (
        !api ||
        typeof api.setOpenClawDrawerOpen !== 'function' ||
        typeof api.onOpenClawStatus !== 'function' ||
        typeof api.onOpenClawLog !== 'function'
      ) {
        return NOOP_CLEANUP;
      }
      const gate = createSeedPushGate(
        observer.onStatus,
        observer.onStatus,
        observer.onError,
      );
      const cleanups: CapabilityCleanup[] = [];
      api.setOpenClawDrawerOpen(true);
      cleanups.push(() => api.setOpenClawDrawerOpen(false));
      try {
        cleanups.push(api.onOpenClawStatus((status) => gate.push(status)));
        cleanups.push(api.onOpenClawLog((line) => gate.event(() => observer.onLog(line))));
      } catch (error) {
        gate.event(() => observer.onError?.(error));
        gate.stop();
        onceCleanup(cleanups)();
        return NOOP_CLEANUP;
      }
      cleanups.push(() => gate.stop());
      gate.seed(() => api.getOpenClawStatus());
      return onceCleanup(cleanups);
    },
    observeChat(observer) {
      const api = desktopFor('getOpenClawStatus');
      if (
        !api ||
        typeof api.setOpenClawChatPanelMounted !== 'function' ||
        typeof api.onOpenClawStatus !== 'function' ||
        typeof api.onOpenClawChatViewState !== 'function'
      ) {
        return NOOP_CLEANUP;
      }
      const gate = createSeedPushGate(
        observer.onStatus,
        observer.onStatus,
        observer.onError,
      );
      const cleanups: CapabilityCleanup[] = [];
      api.setOpenClawChatPanelMounted(true);
      cleanups.push(() => api.closeOpenClawChatView());
      cleanups.push(() => api.setOpenClawChatPanelMounted(false));
      try {
        cleanups.push(api.onOpenClawStatus((status) => gate.push(status)));
        cleanups.push(
          api.onOpenClawChatViewState((state) =>
            gate.event(() => observer.onViewState(state))),
        );
      } catch (error) {
        gate.event(() => observer.onError?.(error));
        gate.stop();
        onceCleanup(cleanups)();
        return NOOP_CLEANUP;
      }
      cleanups.push(() => gate.stop());
      gate.seed(() => api.getOpenClawStatus());
      return onceCleanup(cleanups);
    },
    observeVisibility(onVisibility, onError) {
      const api = desktopFor('getOpenClawVisibility');
      if (!api || typeof api.onOpenClawVisibilityChanged !== 'function') {
        return NOOP_CLEANUP;
      }
      const gate = createSeedPushGate(onVisibility, onVisibility, onError);
      let unsubscribe: CapabilityCleanup;
      try {
        unsubscribe = api.onOpenClawVisibilityChanged((visibility) => gate.push(visibility));
      } catch (error) {
        gate.event(() => onError?.(error));
        gate.stop();
        return NOOP_CLEANUP;
      }
      gate.seed(() => api.getOpenClawVisibility());
      return onceCleanup([unsubscribe, () => gate.stop()]);
    },
    async getStatus(force) {
      const api = desktopFor('getOpenClawStatus');
      return api ? api.getOpenClawStatus(force) : null;
    },
    async runLifecycle(action) {
      const api = desktopFor('runOpenClawLifecycle');
      return api ? api.runOpenClawLifecycle(action) : null;
    },
    async runAutostart(action) {
      const api = desktopFor('runOpenClawAutostart');
      return api ? api.runOpenClawAutostart(action) : null;
    },
    async listSessions() {
      const api = desktopFor('listOpenClawSessions');
      return api ? api.listOpenClawSessions() : null;
    },
    async getConfig() {
      const api = desktopFor('getOpenClawConfig');
      return api ? api.getOpenClawConfig() : null;
    },
    async setConfig(key, value) {
      const api = desktopFor('setOpenClawConfig');
      return api ? api.setOpenClawConfig(key, value) : null;
    },
    async getMode() {
      const api = desktopFor('getOpenClawMode');
      return api ? api.getOpenClawMode() : null;
    },
    async setMode(mode) {
      const api = desktopFor('setOpenClawMode');
      if (!api) return false;
      await api.setOpenClawMode(mode);
      return true;
    },
    setChatVisible(visible) {
      const api = desktopFor('setOpenClawChatVisible');
      if (!api) return false;
      api.setOpenClawChatVisible(visible);
      return true;
    },
    openChat() {
      const api = desktopFor('openOpenClawChatView');
      if (!api) return false;
      api.openOpenClawChatView();
      return true;
    },
    closeChat() {
      const api = desktopFor('closeOpenClawChatView');
      if (!api) return false;
      api.closeOpenClawChatView();
      return true;
    },
    reloadChat() {
      const api = desktopFor('reloadOpenClawChatView');
      if (!api) return false;
      api.reloadOpenClawChatView();
      return true;
    },
    setChatBounds(bounds) {
      const api = desktopFor('setOpenClawChatBounds');
      if (!api) return false;
      api.setOpenClawChatBounds(bounds);
      return true;
    },
    async openChatExternal() {
      const api = desktopFor('openOpenClawChatExternal');
      return api ? api.openOpenClawChatExternal() : false;
    },
  };

  const remoteDesktop: RemoteDesktopAccess = {
    observe(onStatus, onError) {
      const api = desktopFor('getRemoteDesktopStatus');
      if (!api || typeof api.onRemoteDesktopStatus !== 'function') return NOOP_CLEANUP;
      const gate = createSeedPushGate(onStatus, onStatus, onError);
      let unsubscribe: CapabilityCleanup;
      try {
        unsubscribe = api.onRemoteDesktopStatus((status) => gate.push(status));
      } catch (error) {
        gate.event(() => onError?.(error));
        gate.stop();
        return NOOP_CLEANUP;
      }
      gate.seed(() => api.getRemoteDesktopStatus());
      return onceCleanup([unsubscribe, () => gate.stop()]);
    },
    async disconnect() {
      const api = desktopFor('disconnectRemoteDesktop');
      return api ? api.disconnectRemoteDesktop() : null;
    },
  };

  const remoteRuntime: RemoteRuntimeAccess = {
    observe(observer) {
      const api = requireCore('getRemoteRuntimeStatus');
      requireCore('getRemoteSecurityStatus');
      requireCore('onRemoteRuntimeStatus');
      const gate = createSeedPushGate(
        observer.onStatus,
        observer.onStatus,
        observer.onError,
      );
      let unsubscribe: CapabilityCleanup;
      try {
        unsubscribe = api.onRemoteRuntimeStatus((status) => gate.push(status));
      } catch (error) {
        gate.event(() => observer.onError?.(error));
        gate.stop();
        return NOOP_CLEANUP;
      }
      gate.seed(() => api.getRemoteRuntimeStatus());
      gate.load(
        () => api.getRemoteSecurityStatus(),
        observer.onSecurity,
      );
      return onceCleanup([unsubscribe, () => gate.stop()]);
    },
    setEnabled(enabled) {
      return requireCore('setRemoteEnabled').setRemoteEnabled(enabled);
    },
    retry() {
      return requireCore('retryRemoteRuntime').retryRemoteRuntime();
    },
  };

  const remotePairing: RemotePairingAccess = {
    observe(observer) {
      const api = requireCore('getRemoteConnectionInfo');
      requireCore('getRemoteSecurityStatus');
      requireCore('getRemoteToken');
      requireCore('getRemoteRuntimeStatus');
      requireCore('onRemoteRuntimeStatus');
      const report = (stage: RemotePairingStage, error: unknown): void => {
        observer.onError?.(stage, error);
      };
      const gate = createSeedPushGate(
        observer.onRuntime,
        observer.onRuntime,
        (error) => report('runtime', error),
      );
      let unsubscribe: CapabilityCleanup = NOOP_CLEANUP;
      try {
        unsubscribe = api.onRemoteRuntimeStatus((status) => gate.push(status));
      } catch (error) {
        gate.event(() => report('runtime', error));
      }

      gate.load(
        () => api.getRemoteConnectionInfo(),
        observer.onConnectionInfo,
        (error) => report('connection', error),
      );
      gate.load(
        () => api.getRemoteSecurityStatus(),
        (status) => {
          observer.onSecurity(status);
          if (status.state !== 'ready') return;
          gate.load(
            () => api.getRemoteToken(),
            observer.onToken,
            (error) => report('token', error),
          );
        },
        (error) => report('security', error),
      );
      gate.seed(() => api.getRemoteRuntimeStatus());
      return onceCleanup([unsubscribe, () => gate.stop()]);
    },
    rotateToken() {
      return requireCore('rotateRemoteToken').rotateRemoteToken();
    },
  };

  const systemStatus: SystemStatusAccess = {
    observe(observer) {
      const api = requireCore('getStatsHistory');
      requireCore('onStatsUpdate');
      const gate = createSeedPushGate(
        observer.onSeed,
        observer.onSnapshot,
        observer.onError,
      );
      let unsubscribe: CapabilityCleanup = NOOP_CLEANUP;
      try {
        unsubscribe = api.onStatsUpdate((snapshot) => gate.push(snapshot));
      } catch (error) {
        gate.event(() => observer.onError?.(error));
      }
      gate.seed(() => api.getStatsHistory());
      return onceCleanup([unsubscribe, () => gate.stop()]);
    },
    capturePackets(onError) {
      try {
        const api = requireCore('subscribePackets');
        requireCore('unsubscribePackets');
        api.subscribePackets();
        return onceCleanup([() => api.unsubscribePackets()]);
      } catch (error) {
        onError?.(error);
        return NOOP_CLEANUP;
      }
    },
  };

  const sshForwards: SshForwardAccess = {
    async list() {
      const api = desktopFor('listSshForwards');
      return api ? api.listSshForwards() : null;
    },
    async stop(connectionId, forwardId) {
      const api = desktopFor('stopSshForward');
      return api ? api.stopSshForward(connectionId, forwardId) : null;
    },
  };

  const uiPreferences: UiPreferenceAccess = {
    async load() {
      const api = desktopFor('getUiPreferences');
      return api ? api.getUiPreferences() : null;
    },
    async save(patch) {
      const api = desktopFor('setUiPreferences');
      return api ? api.setUiPreferences(patch) : null;
    },
    async refreshNativeMenuLocale() {
      const api = desktopFor('refreshNativeMenuLocale');
      if (!api) return false;
      await api.refreshNativeMenuLocale();
      return true;
    },
  };

  const files: FileAccess = {
    list(path) {
      return requireCore('listFiles').listFiles(path);
    },
    listRoots() {
      return requireCore('listFileRoots').listFileRoots();
    },
    preview(path) {
      return requireCore('readFilePreview').readFilePreview(path);
    },
    createFolder(path, name) {
      return requireCore('createFolder').createFolder(path, name);
    },
    rename(path, name) {
      return requireCore('renameFile').renameFile(path, name);
    },
    trash(path) {
      return requireCore('trashFile').trashFile(path);
    },
    openInApp(path) {
      return requireCore('openFileInApp').openFileInApp(path);
    },
    reveal(path) {
      return requireCore('revealFileInExplorer').revealFileInExplorer(path);
    },
    pathForDrop(file) {
      const api = desktopFor('getPathForFile');
      return api ? api.getPathForFile(file) : null;
    },
    async openExternalHttpUrl(url) {
      const api = desktopFor('openExternalHttpUrl');
      return api ? api.openExternalHttpUrl(url) : false;
    },
  };

  return {
    snapshot: () => ({
      core: resolveCore() ? 'available' : 'unavailable',
      desktop: resolveDesktop() ? 'available' : 'unavailable',
    }),
    runtimeVersions: () => resolveCore()?.versions ?? null,
    agentIntegrations,
    openClaw,
    remoteDesktop,
    remotePairing,
    remoteRuntime,
    systemStatus,
    sshForwards,
    uiPreferences,
    files,
  };
}

export const rendererCapabilities = createCapabilityAccess({
  readCore: () => (typeof window === 'undefined' ? undefined : window.ezterminal),
  readDesktop: () => (typeof window === 'undefined' ? undefined : window.ezterminalDesktop),
});
