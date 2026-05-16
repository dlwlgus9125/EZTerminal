/**
 * Component tests for Scrollback save [R-L4-04]
 * AC-L4-04-1: SerializeAddon.serialize() result sent to scrollback:save IPC
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockTerminal } from "../mocks/xterm";
import { mockXterm } from "../mocks/xterm";

let lastTerminal: MockTerminal | null = null;

class MockSearchAddon {
  activate = vi.fn();
  dispose = vi.fn();
  findNext = vi.fn().mockReturnValue(true);
  findPrevious = vi.fn().mockReturnValue(true);
}

const FAKE_SERIALIZED = "line1\nline2\nline3";

class MockSerializeAddon {
  activate = vi.fn();
  dispose = vi.fn();
  serialize = vi.fn().mockReturnValue(FAKE_SERIALIZED);
}

let serializeAddonInstance: MockSerializeAddon | null = null;

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: MockSearchAddon,
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class extends MockSerializeAddon {
    constructor() {
      super();
      serializeAddonInstance = this;
    }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class extends mockXterm.Terminal {
    constructor(opts?: Record<string, unknown>) {
      super(opts);
      lastTerminal = this as unknown as MockTerminal;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = vi.fn();
    activate = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate = vi.fn();
    dispose = vi.fn();
    onContextLoss = { event: vi.fn().mockReturnValue(() => {}) };
  },
}));

const { TerminalView } = await import("../../src/renderer/components/Terminal/TerminalView");

// ── AC-L4-04-1: Scrollback save ──────────────────────────────────────────────

describe("Scrollback save", () => {
  beforeEach(() => {
    lastTerminal = null;
    serializeAddonInstance = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads SerializeAddon on mount", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    expect(serializeAddonInstance).not.toBeNull();
  });

  it("__saveScrollback__ is exposed on window after mount", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    const win = window as unknown as { __saveScrollback__?: () => Promise<void> };
    expect(typeof win.__saveScrollback__).toBe("function");
  });

  it("calling __saveScrollback__ invokes SerializeAddon.serialize and scrollback.save IPC", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });

    const win = window as unknown as { __saveScrollback__?: () => Promise<void> };
    expect(win.__saveScrollback__).toBeDefined();

    await win.__saveScrollback__?.();

    expect(serializeAddonInstance?.serialize).toHaveBeenCalled();
    expect(window.electronAPI.scrollback.save).toHaveBeenCalledWith(FAKE_SERIALIZED);
  });
});
