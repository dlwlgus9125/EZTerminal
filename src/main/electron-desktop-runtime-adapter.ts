import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  safeStorage,
  Tray,
} from 'electron';
import type { BrowserWindow as BrowserWindowType, IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import type { RemoteDesktopHostStatus, RemoteDesktopServiceHealth } from '../shared/ipc';
import {
  ManagedDesktopRuntime,
  describeDesktopRuntimeError,
  type DesktopRuntime,
  type DesktopRuntimeIpcAdapter,
  type DesktopRuntimeIpcHandler,
  type DesktopStatusPresentation,
} from './desktop-runtime';
import {
  DEFAULT_REMOTE_BRIDGE_PORT,
  startRemoteBridge,
  type RemoteBridgeHandle,
  type RemoteBridgeOptions,
} from './remote-bridge';
import { RemoteDeviceRoster } from './remote-device-roster';
import { parseRemoteDesktopServiceProbe } from './native-desktop-protocol';
import { formatConnectionInfo } from './remote-connection-info';
import { RemoteDesktopController } from './remote-desktop-controller';
import { RemoteRuntimeStartError } from './remote-runtime';
import { RemoteTokenStore } from './remote-token-store';
import { selectTrustedRemoteNetwork } from './trusted-remote-network';
import { resolveNativeHostPath } from './native-host-path';

export type ElectronDesktopRuntimeBridgeSources = Pick<
  RemoteBridgeOptions,
  | 'broker'
  | 'sessionSurfaceAuthority'
  | 'statsSource'
  | 'packetSource'
  | 'fileSource'
  | 'worktreeSource'
  | 'quickCommandSource'
  | 'openclawSource'
  | 'agentSource'
  | 'agentCoordinationSource'
  | 'agentHistorySource'
  | 'gitSource'
  | 'pairingSource'
  | 'runLeases'
>;

export interface ElectronDesktopRuntimeOptions {
  readonly readDesiredEnabled: () => Promise<boolean>;
  readonly writeDesiredEnabled: (enabled: boolean) => Promise<void>;
  readonly waitUntilBridgeReady: () => Promise<void>;
  readonly prepareBridge: () => Promise<void>;
  readonly stopAuxiliaryRuntime: () => Promise<void>;
  readonly bridgeSources: ElectronDesktopRuntimeBridgeSources;
  readonly getMainWindow?: () => BrowserWindowType | null;
  readonly requestQuit?: () => void;
  /** Defaults to enabled on Windows; tests and unsupported hosts may disable it. */
  readonly desktopControlEnabled?: boolean;
  /** Injected so main can read the roster the bridge feeds. */
  readonly deviceRoster?: RemoteDeviceRoster;
  /** Invalidates one-time codes as the managed listener leaves running. */
  readonly revokePairingCodes?: () => void;
}

function reportDesktopRuntimeError(context: string, error: unknown): void {
  console.error(`[main] ${context}: ${describeDesktopRuntimeError(error)}`);
}

function publishToDesktopWindows(channel: string, status: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(channel, status);
  }
}

function probeRemoteDesktopService(hostPath: string): Promise<RemoteDesktopServiceHealth> {
  return new Promise((resolve) => {
    execFile(
      hostPath,
      ['--probe'],
      { windowsHide: true, timeout: 3_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve('unknown');
          return;
        }
        resolve(parseRemoteDesktopServiceProbe(stdout));
      },
    );
  });
}

class ElectronDesktopStatusPresentation implements DesktopStatusPresentation {
  private destroyed = false;

  constructor(
    private readonly tray: Tray,
    private readonly desktopHost: RemoteDesktopController,
    private readonly getMainWindow: () => BrowserWindowType | null,
    private readonly requestQuit: () => void,
  ) {
    this.tray.on('click', () => this.openMainWindow());
  }

  update(status: RemoteDesktopHostStatus): void {
    if (this.destroyed) return;
    const korean = app.getLocale().toLowerCase().startsWith('ko');
    const active = status.controllerName !== null;
    const error = status.state === 'error' || ['missing', 'stopped', 'denied'].includes(status.service);
    const stateLabel = active
      ? (korean ? `제어 중: ${status.controllerName}` : `Controlled by ${status.controllerName}`)
      : error
        ? (korean ? 'PC 제어 오류' : 'PC Control error')
        : (korean ? 'PC 제어 대기' : 'PC Control idle');
    this.tray.setToolTip(`EZTerminal — ${stateLabel}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: korean ? 'EZTerminal 열기' : 'Open EZTerminal', click: () => this.openMainWindow() },
      {
        label: active
          ? (korean ? `${status.controllerName} 연결 끊기` : `Disconnect ${status.controllerName}`)
          : (korean ? '연결 끊기' : 'Disconnect'),
        enabled: active,
        click: () => {
          void this.desktopHost.shutdown('local-disconnect').catch((shutdownError) => {
            reportDesktopRuntimeError('remote desktop tray disconnect failed', shutdownError);
          });
        },
      },
      { type: 'separator' },
      { label: korean ? '종료…' : 'Quit…', click: () => this.requestQuit() },
    ]));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tray.removeAllListeners();
    this.tray.destroy();
  }

  private openMainWindow(): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createDesktopPresentation(
  desktopHost: RemoteDesktopController,
  getMainWindow: () => BrowserWindowType | null,
  requestQuit: () => void,
): DesktopStatusPresentation | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const trayIcon = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(app.getAppPath(), 'assets', 'icon.ico');
    return new ElectronDesktopStatusPresentation(new Tray(trayIcon), desktopHost, getMainWindow, requestQuit);
  } catch (error) {
    reportDesktopRuntimeError('remote desktop tray unavailable', error);
    return undefined;
  }
}

function createTokenStore(): RemoteTokenStore {
  return new RemoteTokenStore(path.join(app.getPath('userData')), {
    protector: process.platform === 'win32'
      ? {
          encrypt: (plaintext) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error('Windows credential encryption is unavailable.');
            }
            return safeStorage.encryptString(plaintext);
          },
          decrypt: (ciphertext) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error('Windows credential encryption is unavailable.');
            }
            return safeStorage.decryptString(ciphertext);
          },
        }
      : undefined,
    requireProtector: process.platform === 'win32',
  });
}

async function stopBridgeResources(
  desktopHost: RemoteDesktopController,
  bridge: RemoteBridgeHandle,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await desktopHost.shutdown('bridge-disabled');
  } catch (error) {
    failures.push(error);
  }
  try {
    await bridge.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Remote bridge resources failed to stop.');
  }
}

/**
 * Electron/OS Adapter for the DesktopRuntime Interface. All native paths,
 * window fan-out, secure storage, tray behavior, network selection, and
 * bridge composition remain behind this seam.
 */
export function createElectronDesktopRuntime(options: ElectronDesktopRuntimeOptions): DesktopRuntime {
  // Survives bridge restarts so "last seen" outlives a toggle of the runtime.
  const deviceRoster = options.deviceRoster ?? new RemoteDeviceRoster();
  const configuredPort = Number(process.env.EZTERMINAL_REMOTE_PORT);
  const remoteBridgePort = Number.isInteger(configuredPort)
    && configuredPort > 0
    && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_REMOTE_BRIDGE_PORT;
  const remoteHostPath = resolveNativeHostPath();
  const vpnInterface = process.env.EZTERMINAL_REMOTE_VPN_INTERFACE;
  const desktopControlEnabled = options.desktopControlEnabled
    ?? process.platform === 'win32';
  const tokenStore = createTokenStore();
  const desktopHost = new RemoteDesktopController({
    hostPath: remoteHostPath,
    probeService: () => probeRemoteDesktopService(remoteHostPath),
  });
  const getMainWindow = options.getMainWindow
    ?? (() => BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null);
  const desktopPresentation = createDesktopPresentation(
    desktopHost,
    getMainWindow,
    options.requestQuit ?? (() => app.quit()),
  );
  const ipc: DesktopRuntimeIpcAdapter = {
    handle: (channel, handler: DesktopRuntimeIpcHandler) => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => handler(event, ...args));
    },
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  };

  return new ManagedDesktopRuntime({
    port: remoteBridgePort,
    ipc,
    tokenStore,
    desktopHost,
    desktopPresentation,
    readDesiredEnabled: options.readDesiredEnabled,
    writeDesiredEnabled: options.writeDesiredEnabled,
    getConnectionInfo: () => {
      const interfaces = networkInterfaces();
      const trustedNetwork = selectTrustedRemoteNetwork(interfaces, vpnInterface);
      return formatConnectionInfo(interfaces, remoteBridgePort, trustedNetwork?.address);
    },
    startBridge: async () => {
      await options.waitUntilBridgeReady();
      const trustedNetwork = selectTrustedRemoteNetwork(networkInterfaces(), vpnInterface);
      if (!trustedNetwork) {
        throw new RemoteRuntimeStartError(
          'REMOTE_TRUSTED_NETWORK_UNAVAILABLE',
          'trusted VPN adapter unavailable',
        );
      }
      await options.prepareBridge();
      // Resolve service readiness before the listener can authenticate a
      // client. The source remains attached when the service is unavailable,
      // but isAvailable() suppresses the capability until a later successful
      // probe instead of weakening terminal-only remote access.
      if (desktopControlEnabled) await desktopHost.probeService();
      const bridge = await startRemoteBridge({
        ...options.bridgeSources,
        port: remoteBridgePort,
        bindHost: trustedNetwork.address,
        getToken: () => tokenStore.getToken(),
        hostVersion: app.getVersion(),
        buildSha: process.env.EZTERMINAL_BUILD_SHA ?? process.env.GITHUB_SHA,
        desktopSource: desktopControlEnabled ? desktopHost : undefined,
        onClientPresence: (identity, presence, connectionId) =>
          deviceRoster.record(identity, connectionId, presence, Date.now()),
      });
      return {
        port: bridge.port,
        stop: async () => {
          // A stopped bridge has no connected clients, whatever it saw earlier.
          deviceRoster.markAllDisconnected(Date.now());
          await stopBridgeResources(desktopHost, bridge);
        },
      };
    },
    stopAuxiliaryRuntime: options.stopAuxiliaryRuntime,
    publishRuntimeStatus: (status) => publishToDesktopWindows('remote:runtime-status', status),
    publishDesktopStatus: (status) => publishToDesktopWindows('remote:desktop-status', status),
    revokePairingCodes: options.revokePairingCodes,
    reportError: reportDesktopRuntimeError,
  });
}
