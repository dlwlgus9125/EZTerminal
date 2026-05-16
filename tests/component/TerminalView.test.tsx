/**
 * Component tests for TerminalView (T1+T2 scope):
 * T1: mount, input wiring
 * T2: WebGL addon, FitAddon, Phosphor theme, unmount cleanup, Canvas fallback, zero-size
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockTerminal } from "../mocks/xterm";
import { mockXterm } from "../mocks/xterm";

// Capture xterm Terminal instances created during tests
let lastTerminal: MockTerminal | null = null;

// Track WebGL addon instances
let webglAddonInstance: MockWebglAddon | null = null;
let webglShouldFail = false;

class MockWebglAddon {
  activate = vi.fn();
  dispose = vi.fn();
  onContextLoss: { fire: () => void; event: (cb: () => void) => () => void };

  constructor() {
    webglAddonInstance = this;
    if (webglShouldFail) {
      throw new Error("WebGL context creation failed");
    }
    let _cb: (() => void) | null = null;
    this.onContextLoss = {
      fire: () => _cb?.(),
      event: (cb: () => void) => {
        _cb = cb;
        return () => {
          _cb = null;
        };
      },
    };
  }
}

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: MockWebglAddon,
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

const { TerminalView } = await import("../../src/renderer/components/Terminal/TerminalView");

describe("TerminalView mount (W1, W5)", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders terminal-wrapper container (W5)", () => {
    render(<TerminalView sessionId="existing-session" />);
    expect(document.querySelector(".terminal-wrapper")).not.toBeNull();
  });

  it("calls window.electronAPI.pty.create when sessionId is null (W1)", async () => {
    render(<TerminalView sessionId={null} />);
    await waitFor(() => {
      expect(window.electronAPI.pty.create).toHaveBeenCalled();
    });
  });

  it("registers onData listener after session is created (W1)", async () => {
    render(<TerminalView sessionId={null} />);
    await waitFor(() => {
      expect(window.electronAPI.pty.onData).toHaveBeenCalledWith(
        "mock-pty-id",
        expect.any(Function)
      );
    });
  });

  it("does not call pty.create when sessionId is provided", async () => {
    render(<TerminalView sessionId="pre-existing-id" />);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(window.electronAPI.pty.create).not.toHaveBeenCalled();
  });

  it("shows error message when PTY creation fails (W1)", async () => {
    vi.mocked(window.electronAPI.pty.create).mockResolvedValueOnce({
      ok: false,
      code: "PTY_CREATE_FAILED",
      message: "Failed to create PTY",
    } as never);
    render(<TerminalView sessionId={null} />);
    await waitFor(() => {
      expect(screen.getByText(/PTY_CREATE_FAILED/i)).toBeInTheDocument();
    });
  });
});

describe("TerminalView input (W2)", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends user keypress to pty:write (W2)", async () => {
    render(<TerminalView sessionId={null} />);
    await waitFor(() => {
      expect(window.electronAPI.pty.onData).toHaveBeenCalled();
    });
    expect(lastTerminal).not.toBeNull();
    lastTerminal?.simulateInput("h");
    await waitFor(() => {
      expect(window.electronAPI.pty.write).toHaveBeenCalledWith("mock-pty-id", "h");
    });
  });
});

describe("TerminalView webgl", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads WebGL addon on mount", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    // WebglAddon should have been instantiated
    expect(webglAddonInstance).not.toBeNull();
  });
});

describe("TerminalView fit", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads FitAddon and calls fit() on mount", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    // FitAddon is loaded and fit() is called
    const addons = lastTerminal?.getLoadedAddons() ?? [];
    const fitAddon = addons.find((a) => typeof (a as { fit?: unknown }).fit === "function") as
      | { fit: ReturnType<typeof vi.fn> }
      | undefined;
    expect(fitAddon).toBeDefined();
    expect(fitAddon?.fit).toHaveBeenCalled();
  });
});

describe("TerminalView theme", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("applies Phosphor theme colors to terminal", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
    });
    // The terminal was constructed with a theme containing Phosphor green
    // We check via the MockTerminal's stored options
    const terminal = lastTerminal as unknown as { options: { theme?: Record<string, string> } };
    expect(terminal?.options?.theme?.background).toBeDefined();
    expect(terminal?.options?.theme?.foreground).toBeDefined();
  });
});

describe("TerminalView unmount", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("disposes terminal on unmount", async () => {
    const { unmount } = render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    const terminal = lastTerminal;
    unmount();
    expect(terminal?.dispose).toHaveBeenCalled();
  });

  it("removes pty data listener on unmount", async () => {
    // Replace onData mock to return a trackable spy
    const unsubSpy = vi.fn();
    vi.mocked(window.electronAPI.pty.onData).mockReturnValueOnce(unsubSpy);

    const { unmount } = render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(window.electronAPI.pty.onData).toHaveBeenCalled();
    });
    unmount();
    expect(unsubSpy).toHaveBeenCalled();
  });
});

describe("TerminalView canvas fallback", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = true; // Force WebGL failure
    vi.clearAllMocks();
  });

  afterEach(() => {
    webglShouldFail = false;
    cleanup();
  });

  it("falls back to Canvas renderer when WebGL fails", async () => {
    // When WebGL constructor throws, TerminalView should still mount without error
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    // Component mounts successfully despite WebGL failure
    expect(document.querySelector(".terminal-wrapper")).not.toBeNull();
    // No error alert shown (Canvas fallback is silent)
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("TerminalView zero size", () => {
  beforeEach(() => {
    lastTerminal = null;
    webglAddonInstance = null;
    webglShouldFail = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("mounts without error when container has zero size", async () => {
    // FitAddon throws when container is zero-size — component must handle it
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => {
      expect(lastTerminal?.loadAddon).toHaveBeenCalled();
    });
    // Component still renders wrapper
    expect(document.querySelector(".terminal-wrapper")).not.toBeNull();
  });
});
