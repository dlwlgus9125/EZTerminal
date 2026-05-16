/**
 * Wiring tests for FilesPanel [R-L3-03, R-L3-04]
 * W1: isVisible=true + CWD set → fs:watch + readDir
 * W2: OSC 7 data → CWD update → readDir
 * W3: fs:changed event → readDir refresh
 * W4: file click → preview URL with ezterm-file://
 * W5: isVisible=false → no watch
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../../src/main/filesystem";

let capturedOnChanged: ((dir: string) => void) | null = null;

beforeEach(() => {
  capturedOnChanged = null;
  vi.mocked(window.electronAPI.fs.onChanged).mockImplementation((cb) => {
    capturedOnChanged = cb;
    return vi.fn();
  });
  vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({ ok: true, data: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { FilesPanel } = await import("../../src/renderer/components/panels/FilesPanel/FilesPanel");

function makeEntry(name: string, isDirectory = false): DirEntry {
  return { name, path: `/cwd/${name}`, isDirectory, size: 100, modifiedAt: Date.now() };
}

// ─── W1: visible + CWD → watch + readDir ──────────────────────────────────────

describe("W1 isVisible + CWD → fs.watch + readDir", () => {
  it("calls fs.watch when CWD is set and visible", async () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);
    await waitFor(() => {
      expect(window.electronAPI.fs.watch).toHaveBeenCalledWith("/cwd");
    });
  });

  it("calls fs.readDir when CWD is set and visible", async () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);
    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalledWith("/cwd");
    });
  });

  it("subscribes to fs.onChanged when visible", () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);
    expect(window.electronAPI.fs.onChanged).toHaveBeenCalled();
  });

  it("does not call fs.watch when not visible", async () => {
    render(<FilesPanel isVisible={false} initialCwd="/cwd" />);
    // Give async effects time
    await new Promise((r) => setTimeout(r, 50));
    expect(window.electronAPI.fs.watch).not.toHaveBeenCalled();
  });
});

// ─── W2: OSC 7 → CWD → readDir ────────────────────────────────────────────────

describe("W2 OSC7 → CWD → readDir", () => {
  it("OSC 7 sequence updates CWD and triggers readDir", async () => {
    render(<FilesPanel isVisible={true} />);

    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      (window as any).__filesPanelHandleOsc7("\x1b]7;file:///home/user/workspace\x07");
    });

    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalledWith("/home/user/workspace");
    });
  });

  it("OSC 7 sequence updates CWD display", async () => {
    render(<FilesPanel isVisible={true} />);

    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      (window as any).__filesPanelHandleOsc7("\x1b]7;file:///new/path\x07");
    });

    await waitFor(() => {
      expect(screen.getByTestId("files-cwd")).toHaveTextContent("/new/path");
    });
  });
});

// ─── W3: fs:changed → readDir ─────────────────────────────────────────────────

describe("W3 fs:changed → readDir refresh", () => {
  it("fs:changed for current CWD triggers fresh readDir", async () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalledTimes(1);
    });

    act(() => {
      capturedOnChanged?.("/cwd");
    });

    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalledTimes(2);
    });
  });

  it("fs:changed for different CWD does not trigger reload", async () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalledTimes(1);
    });

    act(() => {
      capturedOnChanged?.("/other/dir");
    });

    await new Promise((r) => setTimeout(r, 30));
    // Still only called once
    expect(window.electronAPI.fs.readDir).toHaveBeenCalledTimes(1);
  });
});

// ─── W4: file click → preview URL ─────────────────────────────────────────────

describe("W4 file click → ezterm-file:// preview", () => {
  it("clicking file sets preview with ezterm-file:// URL", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("notes.txt")],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-entry-notes.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("file-entry-notes.txt"));

    const frame = screen.getByTestId("files-preview-frame") as HTMLIFrameElement;
    expect(frame.src).toContain("ezterm-file://");
  });

  it("clicking directory does not open preview", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("src", true)],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-entry-src")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("file-entry-src"));

    expect(document.querySelector("[data-testid='files-preview']")).toBeNull();
  });
});

// ─── W5: unmount unsubs ────────────────────────────────────────────────────────

describe("W5 unmount → cleanup", () => {
  it("unmounting calls the unsubscribe from onChanged", () => {
    const { unmount } = render(<FilesPanel isVisible={true} initialCwd="/cwd" />);
    const unsub = vi.mocked(window.electronAPI.fs.onChanged).mock.results[0]
      ?.value as unknown as ReturnType<typeof vi.fn>;
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
});
