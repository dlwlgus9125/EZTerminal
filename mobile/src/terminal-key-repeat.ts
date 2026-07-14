export const TERMINAL_KEY_REPEAT_DELAY_MS = 400;
export const TERMINAL_KEY_REPEAT_INTERVAL_MS = 45;

export interface TerminalKeyRepeatController {
  readonly start: (bytes: string, repeatable: boolean) => void;
  readonly stop: () => void;
}

interface RepeatScheduler {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const defaultScheduler: RepeatScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle),
};

export function createTerminalKeyRepeatController(
  send: (bytes: string) => void,
  scheduler: RepeatScheduler = defaultScheduler,
): TerminalKeyRepeatController {
  let delayHandle: ReturnType<typeof setTimeout> | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (delayHandle !== null) scheduler.clearTimeout(delayHandle);
    if (intervalHandle !== null) scheduler.clearInterval(intervalHandle);
    delayHandle = null;
    intervalHandle = null;
  };

  return {
    start(bytes, repeatable) {
      stop();
      send(bytes);
      if (!repeatable) return;
      delayHandle = scheduler.setTimeout(() => {
        delayHandle = null;
        send(bytes);
        intervalHandle = scheduler.setInterval(() => send(bytes), TERMINAL_KEY_REPEAT_INTERVAL_MS);
      }, TERMINAL_KEY_REPEAT_DELAY_MS);
    },
    stop,
  };
}
