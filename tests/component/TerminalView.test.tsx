/**
 * Component tests for TerminalView (T1 skeleton scope):
 * W1: Data binding — component mounts, xterm opens in container
 * W2: Interaction — user input reaches PTY write
 * W5: Template — TerminalView instantiates and renders container
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockTerminal } from "../mocks/xterm";
import { mockXterm } from "../mocks/xterm";

// Capture xterm Terminal instances created during tests
let lastTerminal: MockTerminal | null = null;

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
  },
}));

const { TerminalView } = await import("../../src/renderer/components/Terminal/TerminalView");

describe("TerminalView mount (W1, W5)", () => {
  beforeEach(() => {
    lastTerminal = null;
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
    // Wait a tick for useEffect
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends user keypress to pty:write (W2)", async () => {
    render(<TerminalView sessionId={null} />);

    // Wait for PTY creation and onData registration
    await waitFor(() => {
      expect(window.electronAPI.pty.onData).toHaveBeenCalled();
    });

    // Simulate xterm onData (user typing) via the captured terminal
    expect(lastTerminal).not.toBeNull();
    lastTerminal?.simulateInput("h");

    await waitFor(() => {
      expect(window.electronAPI.pty.write).toHaveBeenCalledWith("mock-pty-id", "h");
    });
  });
});
