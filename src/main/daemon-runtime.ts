import type {
  AutomationEnableResult,
  DaemonLifecycleSettings,
  DaemonLifecycleSettingsController,
} from './daemon-lifecycle-settings';
import { AutomationEnableCoordinator } from './daemon-lifecycle-settings';

export interface MainWindowCloseEvent {
  preventDefault(): void;
}

export interface DaemonMainWindow {
  hide(): void;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
}

export interface DaemonProcessOwner {
  stopAll(reason?: string): Promise<void>;
}

export interface DaemonRuntimeOptions {
  readonly settings: DaemonLifecycleSettingsController;
  readonly processes: DaemonProcessOwner;
  readonly getMainWindow: () => DaemonMainWindow | null;
  readonly createMainWindow: () => DaemonMainWindow;
  readonly requestAppQuit: () => void;
}

/**
 * User-level daemon policy owned by Electron main. This is intentionally not
 * an executable or Windows service: renderer windows are optional clients of
 * the same main-process runtime that owns terminal and provider processes.
 */
export class DaemonRuntime {
  private readonly automation: AutomationEnableCoordinator;
  private initialization: Promise<DaemonLifecycleSettings> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: DaemonRuntimeOptions) {
    this.automation = new AutomationEnableCoordinator(options.settings);
  }

  initialize(): Promise<DaemonLifecycleSettings> {
    if (!this.initialization) this.initialization = this.options.settings.initialize();
    return this.initialization;
  }

  settingsSnapshot(): DaemonLifecycleSettings {
    return this.options.settings.snapshot();
  }

  shouldKeepRunning(): boolean {
    return this.settingsSnapshot().keepRunning;
  }

  updateSettings(patch: Partial<DaemonLifecycleSettings>): Promise<DaemonLifecycleSettings> {
    return this.options.settings.update(patch);
  }

  enableAutomation(
    requestConsent: () => boolean | Promise<boolean>,
    activate: () => void | Promise<void>,
  ): Promise<AutomationEnableResult> {
    return this.automation.enable(requestConsent, activate);
  }

  handleMainWindowClose(event: MainWindowCloseEvent, window: DaemonMainWindow): void {
    event.preventDefault();
    if (this.shouldKeepRunning()) {
      window.hide();
      return;
    }
    this.options.requestAppQuit();
  }

  openMainWindow(): DaemonMainWindow {
    const existing = this.options.getMainWindow();
    const window = !existing || existing.isDestroyed()
      ? this.options.createMainWindow()
      : existing;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  requestExplicitQuit(): void {
    this.options.requestAppQuit();
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.options.processes.stopAll('app-quit');
    return this.shutdownPromise;
  }
}
