/**
 * Mock for node-pty in test environments.
 * Provides a mock IPty implementation that echoes input back.
 */

import { vi } from "vitest";

type DataCallback = (data: string) => void;
type ExitCallback = (exitCode: number, signal?: number) => void;

export interface MockPtyOptions {
  cols?: number;
  rows?: number;
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export class MockIPty {
  readonly pid: number;
  cols: number;
  rows: number;
  process: string;
  handleFlowControl: boolean;

  private dataCallbacks: DataCallback[] = [];
  private exitCallbacks: ExitCallback[] = [];
  private killed = false;

  constructor(
    public readonly file: string,
    public readonly args: string[] | string,
    options: MockPtyOptions = {}
  ) {
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.process = file;
    this.handleFlowControl = false;
  }

  get onData(): { event: (callback: DataCallback) => void } {
    return {
      event: (callback: DataCallback) => {
        this.dataCallbacks.push(callback);
      },
    };
  }

  get onExit(): { event: (callback: ExitCallback) => void } {
    return {
      event: (callback: ExitCallback) => {
        this.exitCallbacks.push(callback);
      },
    };
  }

  write(data: string): void {
    if (this.killed) return;
    // Echo input back (simulates a basic shell)
    const echo = `echo: ${data}`;
    for (const cb of this.dataCallbacks) {
      cb(echo);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(signal?: string): void {
    if (this.killed) return;
    this.killed = true;
    const sigNum = signal === "SIGKILL" ? 9 : 0;
    for (const cb of this.exitCallbacks) {
      cb(0, sigNum);
    }
  }

  pause(): void {
    // noop in mock
  }

  resume(): void {
    // noop in mock
  }

  /**
   * Test helper: emit data as if the PTY produced it
   */
  emitData(data: string): void {
    for (const cb of this.dataCallbacks) {
      cb(data);
    }
  }

  /**
   * Test helper: emit exit event
   */
  emitExit(exitCode: number, signal?: number): void {
    for (const cb of this.exitCallbacks) {
      cb(exitCode, signal);
    }
  }
}

/**
 * Mock spawn function that creates MockIPty instances
 */
export const mockSpawn = vi.fn(
  (file: string, args: string[] | string, options?: MockPtyOptions): MockIPty => {
    return new MockIPty(file, args, options);
  }
);

export const mockNodePty = {
  spawn: mockSpawn,
};

/**
 * Reset mock state between tests
 */
export function resetNodePtyMocks(): void {
  mockSpawn.mockClear();
}
