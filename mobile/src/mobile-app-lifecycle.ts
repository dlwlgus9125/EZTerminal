export const MOBILE_BACKGROUND_SUSPEND_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface MobileAppLifecycleOptions {
  readonly initiallyActive: boolean;
  readonly suspendDelayMs?: number;
  readonly onActivityChange?: (active: boolean) => void;
  readonly onSuspend: () => void;
  readonly onResume: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (handle: TimerHandle) => void;
}

/**
 * Collapses Capacitor and Page Visibility notifications into one idempotent
 * lifecycle. A short Android interruption remains a warm passive surface;
 * only a continuous background interval crosses the suspend boundary.
 */
export class MobileAppLifecycleController {
  private active: boolean;
  private suspended = false;
  private disposed = false;
  private suspendTimer: TimerHandle | null = null;
  private readonly suspendDelayMs: number;
  private readonly onActivityChange: (active: boolean) => void;
  private readonly onSuspend: () => void;
  private readonly onResume: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;

  constructor(options: MobileAppLifecycleOptions) {
    this.active = options.initiallyActive;
    this.suspendDelayMs = options.suspendDelayMs ?? MOBILE_BACKGROUND_SUSPEND_MS;
    this.onActivityChange = options.onActivityChange ?? (() => undefined);
    this.onSuspend = options.onSuspend;
    this.onResume = options.onResume;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.onActivityChange(this.active);
    if (!this.active) this.armSuspend();
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.onActivityChange(active);
    if (!active) {
      this.armSuspend();
      return;
    }
    this.clearSuspendTimer();
    if (!this.suspended) return;
    this.suspended = false;
    this.onResume();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSuspendTimer();
  }

  private armSuspend(): void {
    if (this.suspended || this.suspendTimer !== null || this.disposed) return;
    this.suspendTimer = this.schedule(() => {
      this.suspendTimer = null;
      if (this.disposed || this.active || this.suspended) return;
      this.suspended = true;
      this.onSuspend();
    }, this.suspendDelayMs);
  }

  private clearSuspendTimer(): void {
    if (this.suspendTimer === null) return;
    this.cancel(this.suspendTimer);
    this.suspendTimer = null;
  }
}

let mobileAppActive = true;
const mobileAppActivityListeners = new Set<(active: boolean) => void>();

export function setMobileAppActive(active: boolean): void {
  if (mobileAppActive === active) return;
  mobileAppActive = active;
  for (const listener of mobileAppActivityListeners) listener(active);
}

export function isMobileAppActive(): boolean {
  return mobileAppActive;
}

export function onMobileAppActivityChange(listener: (active: boolean) => void): () => void {
  mobileAppActivityListeners.add(listener);
  return () => mobileAppActivityListeners.delete(listener);
}
