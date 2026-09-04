import type { DaemonRuntimeSettings } from '../shared/daemon-protocol';

export type DaemonLifecycleSettings = Pick<
  DaemonRuntimeSettings,
  'keepRunning' | 'startAtLogin'
>;

export const DEFAULT_DAEMON_LIFECYCLE_SETTINGS: DaemonLifecycleSettings = Object.freeze({
  keepRunning: false,
  startAtLogin: false,
});

export interface DaemonLifecycleSettingsStore {
  read(): Promise<DaemonLifecycleSettings>;
  write(settings: DaemonLifecycleSettings): Promise<void>;
}

/** The narrow Electron login-item surface needed by the lifecycle policy. */
export interface LoginItemAdapter {
  readEnabled(): boolean | Promise<boolean>;
  writeEnabled(enabled: boolean): void | Promise<void>;
}

export interface DaemonLifecycleSettingsOptions {
  readonly store: DaemonLifecycleSettingsStore;
  readonly loginItem: LoginItemAdapter;
  readonly reportError?: (context: string, error: unknown) => void;
}

export type AutomationEnableResult =
  | { readonly ok: true; readonly settings: DaemonLifecycleSettings }
  | {
      readonly ok: false;
      readonly reason: 'cancelled' | 'lifecycle-settings-failed' | 'activation-failed';
      readonly settings: DaemonLifecycleSettings;
    };

function normalizeSettings(settings: DaemonLifecycleSettings): DaemonLifecycleSettings {
  const keepRunning = settings.keepRunning === true;
  return {
    keepRunning,
    startAtLogin: keepRunning && settings.startAtLogin === true,
  };
}

/**
 * Serializes the persisted keep-running preference with Electron's OS login
 * registration. A requested mutation is not published or persisted until the
 * native registration can be read back. If either side fails, the native side
 * is rolled back before the failure is returned.
 */
export class DaemonLifecycleSettingsController {
  private current = DEFAULT_DAEMON_LIFECYCLE_SETTINGS;
  private initialization: Promise<DaemonLifecycleSettings> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DaemonLifecycleSettingsOptions) {}

  initialize(): Promise<DaemonLifecycleSettings> {
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  snapshot(): DaemonLifecycleSettings {
    return { ...this.current };
  }

  async update(
    patch: Partial<DaemonLifecycleSettings>,
  ): Promise<DaemonLifecycleSettings> {
    await this.initialize();
    const operation = this.mutationTail.then(() => this.applyUpdate(patch));
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async initializeOnce(): Promise<DaemonLifecycleSettings> {
    const persisted = normalizeSettings(await this.options.store.read());
    let loginEnabled = false;
    try {
      loginEnabled = await this.options.loginItem.readEnabled();
    } catch (error) {
      this.report('login item status read failed', error);
    }

    // Never silently re-enable an OS login item during startup. If Windows or
    // the user disabled it outside the app, make the persisted status truthful.
    const reconciled = loginEnabled === persisted.startAtLogin
      ? persisted
      : { ...persisted, startAtLogin: loginEnabled && persisted.keepRunning };

    if (reconciled.startAtLogin !== persisted.startAtLogin) {
      try {
        await this.options.store.write(reconciled);
      } catch (error) {
        this.report('reconciled lifecycle settings persistence failed', error);
        throw error;
      }
    }

    // A stale externally-created registration must not survive a setting that
    // explicitly says background execution is disabled.
    if (loginEnabled && !reconciled.startAtLogin) {
      try {
        await this.options.loginItem.writeEnabled(false);
      } catch (error) {
        this.report('stale login item cleanup failed', error);
      }
    }

    this.current = Object.freeze({ ...reconciled });
    return this.snapshot();
  }

  private async applyUpdate(
    patch: Partial<DaemonLifecycleSettings>,
  ): Promise<DaemonLifecycleSettings> {
    const previous = this.snapshot();
    let next = normalizeSettings({
      keepRunning: patch.keepRunning ?? previous.keepRunning,
      startAtLogin: patch.startAtLogin ?? previous.startAtLogin,
    });

    // Starting at login has no useful meaning without the daemon remaining
    // alive, and disabling background execution removes its login item too.
    if (patch.startAtLogin === true) next = { keepRunning: true, startAtLogin: true };
    if (patch.keepRunning === false) next = { keepRunning: false, startAtLogin: false };
    if (
      next.keepRunning === previous.keepRunning
      && next.startAtLogin === previous.startAtLogin
    ) return previous;

    const loginChanged = next.startAtLogin !== previous.startAtLogin;
    if (loginChanged) {
      try {
        await this.options.loginItem.writeEnabled(next.startAtLogin);
        const observed = await this.options.loginItem.readEnabled();
        if (observed !== next.startAtLogin) {
          throw new Error('Windows did not apply the requested login item state.');
        }
      } catch (error) {
        await this.rollbackLoginItem(previous.startAtLogin);
        throw error;
      }
    }

    try {
      await this.options.store.write(next);
    } catch (error) {
      if (loginChanged) await this.rollbackLoginItem(previous.startAtLogin);
      throw error;
    }

    this.current = Object.freeze({ ...next });
    return this.snapshot();
  }

  private async rollbackLoginItem(enabled: boolean): Promise<void> {
    try {
      await this.options.loginItem.writeEnabled(enabled);
      const observed = await this.options.loginItem.readEnabled();
      if (observed !== enabled) {
        throw new Error('Windows did not restore the previous login item state.');
      }
    } catch (error) {
      this.report('login item rollback failed', error);
    }
  }

  private report(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics must never change lifecycle state.
    }
  }
}

/**
 * First-use automation gate. The schedule/heartbeat owner supplies the actual
 * activation callback, which is invoked only after consent and both lifecycle
 * settings have committed successfully.
 */
export class AutomationEnableCoordinator {
  constructor(private readonly settings: DaemonLifecycleSettingsController) {}

  async enable(
    requestConsent: () => boolean | Promise<boolean>,
    activate: () => void | Promise<void>,
  ): Promise<AutomationEnableResult> {
    let current = await this.settings.initialize();
    if (!current.keepRunning || !current.startAtLogin) {
      if (!await requestConsent()) {
        return { ok: false, reason: 'cancelled', settings: current };
      }
      try {
        current = await this.settings.update({ keepRunning: true, startAtLogin: true });
      } catch {
        return {
          ok: false,
          reason: 'lifecycle-settings-failed',
          settings: this.settings.snapshot(),
        };
      }
    }

    try {
      await activate();
      return { ok: true, settings: current };
    } catch {
      return { ok: false, reason: 'activation-failed', settings: current };
    }
  }
}
