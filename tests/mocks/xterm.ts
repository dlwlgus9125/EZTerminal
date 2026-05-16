/**
 * Mock for xterm.js Terminal in test environments.
 * Provides a stub Terminal class that tracks calls without DOM dependencies.
 */

import { vi } from "vitest";

type KeyHandler = (event: { domEvent: KeyboardEvent; key: string }) => boolean;
type DataHandler = (data: string) => void;
type ResizeHandler = (size: { cols: number; rows: number }) => void;

export interface MockTerminalOptions {
  cols?: number;
  rows?: number;
  theme?: Record<string, string>;
  fontSize?: number;
  fontFamily?: string;
}

export class MockTerminal {
  cols: number;
  rows: number;
  element: HTMLElement | null = null;
  textarea: HTMLTextAreaElement | null = null;

  private readonly options: MockTerminalOptions;
  private readonly dataHandlers: DataHandler[] = [];
  private readonly resizeHandlers: ResizeHandler[] = [];
  private keyHandlers: KeyHandler[] = [];
  private readonly _buffer: string[] = [];
  private loadedAddons: unknown[] = [];

  onData = (handler: DataHandler): { dispose: () => void } => {
    this.dataHandlers.push(handler);
    return {
      dispose: () => {
        const idx = this.dataHandlers.indexOf(handler);
        if (idx !== -1) this.dataHandlers.splice(idx, 1);
      },
    };
  };

  onResize = (handler: ResizeHandler): { dispose: () => void } => {
    this.resizeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = this.resizeHandlers.indexOf(handler);
        if (idx !== -1) this.resizeHandlers.splice(idx, 1);
      },
    };
  };

  constructor(options: MockTerminalOptions = {}) {
    this.options = options;
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
  }

  open = vi.fn((parent: HTMLElement): void => {
    this.element = parent;
    const textarea = document.createElement("textarea");
    this.textarea = textarea;
    parent.appendChild(textarea);
  });

  write = vi.fn((data: string | Uint8Array): void => {
    const str = typeof data === "string" ? data : new TextDecoder().decode(data);
    this._buffer.push(str);
  });

  writeln = vi.fn((data: string): void => {
    this._buffer.push(`${data}\r\n`);
  });

  clear = vi.fn((): void => {
    this._buffer.length = 0;
  });

  reset = vi.fn((): void => {
    this._buffer.length = 0;
  });

  resize = vi.fn((cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
    for (const handler of this.resizeHandlers) {
      handler({ cols, rows });
    }
  });

  focus = vi.fn((): void => {
    // noop
  });

  blur = vi.fn((): void => {
    // noop
  });

  dispose = vi.fn((): void => {
    this.dataHandlers.length = 0;
    this.resizeHandlers.length = 0;
    this.keyHandlers = [];
    this.element = null;
    this.textarea = null;
  });

  attachCustomKeyEventHandler = vi.fn((handler: KeyHandler): void => {
    this.keyHandlers.push(handler);
  });

  loadAddon = vi.fn((addon: unknown): void => {
    this.loadedAddons.push(addon);
    // Call activate if the addon has it
    const addonWithActivate = addon as { activate?: (terminal: MockTerminal) => void };
    if (typeof addonWithActivate.activate === "function") {
      addonWithActivate.activate(this);
    }
  });

  select = vi.fn((_column: number, _row: number, _length: number): void => {
    // noop
  });

  selectAll = vi.fn((): void => {
    // noop
  });

  clearSelection = vi.fn((): void => {
    // noop
  });

  getSelection = vi.fn((): string => {
    return "";
  });

  scrollToBottom = vi.fn((): void => {
    // noop
  });

  scrollToTop = vi.fn((): void => {
    // noop
  });

  // Test helpers

  /** Get all buffered text output */
  getOutput(): string {
    return this._buffer.join("");
  }

  /** Simulate user typing (triggers onData handlers) */
  simulateInput(data: string): void {
    for (const handler of this.dataHandlers) {
      handler(data);
    }
  }

  /** Get loaded addons */
  getLoadedAddons(): unknown[] {
    return [...this.loadedAddons];
  }
}

export const mockXterm = {
  Terminal: MockTerminal,
};
