/**
 * Component tests for FilesPanel [R-L3-03, R-L3-04]
 * AC-L3-03-1: CWD OSC 7
 * AC-L3-03-2: Win32 CWD fallback
 * AC-L3-03-3: file tree + virtual scroll
 * AC-L3-03-4: realtime detect
 * AC-L3-03-N1: access denied
 * AC-L3-04-1: text preview
 * AC-L3-04-2: image preview
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../../src/shared/filesystem-types";

let capturedOnChanged: ((dir: string) => void) | null = null;

beforeEach(() => {
  capturedOnChanged = null;
  vi.mocked(window.electronAPI.fs.onChanged).mockImplementation((cb) => {
    capturedOnChanged = cb;
    return () => {
      capturedOnChanged = null;
    };
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

// ─── CWD detection ───────────────────────────────────────────────────────────

describe("FilesPanel CWD OSC7", () => {
  it("AC-L3-03-1: FilesPanel CWD OSC7 — updates CWD from OSC 7 sequence", async () => {
    render(<FilesPanel isVisible={true} />);

    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      (window as any).__filesPanelHandleOsc7("\x1b]7;file:///home/user/project\x07");
    });

    await waitFor(() => {
      expect(screen.getByTestId("files-cwd")).toHaveTextContent("/home/user/project");
    });
  });

  it("AC-L3-03-1: FilesPanel CWD OSC7 — ignores invalid OSC 7 data", async () => {
    render(<FilesPanel isVisible={true} />);

    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      (window as any).__filesPanelHandleOsc7("not an osc7 sequence");
    });

    // CWD should remain empty
    expect(document.querySelector("[data-testid='files-cwd']")).toBeNull();
  });
});

describe("FilesPanel CWD fallback", () => {
  it("AC-L3-03-2: FilesPanel CWD fallback — accepts initialCwd prop as fallback", () => {
    render(<FilesPanel isVisible={true} initialCwd="/fallback/dir" />);
    expect(screen.getByTestId("files-cwd")).toHaveTextContent("/fallback/dir");
  });

  it("AC-L3-03-2: FilesPanel CWD fallback — uses setCwd test hook for Win32 fallback", async () => {
    render(<FilesPanel isVisible={true} />);

    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook
      (window as any).__filesPanelSetCwd("C:\\Users\\user\\project");
    });

    await waitFor(() => {
      expect(screen.getByTestId("files-cwd")).toHaveTextContent("C:\\Users\\user\\project");
    });
  });
});

// ─── File tree ────────────────────────────────────────────────────────────────

describe("FilesPanel tree", () => {
  it("AC-L3-03-3: FilesPanel tree — renders file tree when entries exist", async () => {
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("file.txt"), makeEntry("subdir", true)],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    });
  });

  it("AC-L3-03-3: FilesPanel tree — shows file names in tree", async () => {
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("readme.md"), makeEntry("src", true)],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-entry-readme.md")).toBeInTheDocument();
      expect(screen.getByTestId("file-entry-src")).toBeInTheDocument();
    });
  });

  it("AC-L3-03-3: FilesPanel tree — virtual scroll container rendered", async () => {
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: Array.from({ length: 20 }, (_, i) => makeEntry(`file${i}.txt`)),
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    });
  });

  it("AC-L3-03-3: FilesPanel tree — shows no-cwd state when cwd empty", () => {
    render(<FilesPanel isVisible={true} />);
    expect(screen.getByTestId("files-no-cwd")).toBeInTheDocument();
  });
});

// ─── Realtime watch ───────────────────────────────────────────────────────────

describe("FilesPanel watch", () => {
  it("AC-L3-03-4: FilesPanel watch — calls fs.watch with CWD", async () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(window.electronAPI.fs.watch).toHaveBeenCalledWith("/cwd");
    });
  });

  it("AC-L3-03-4: FilesPanel watch — reloads on fs:changed event", async () => {
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("old.txt")],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalled();
    });

    // Simulate a new file appears
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("old.txt"), makeEntry("new.txt")],
    });

    act(() => {
      capturedOnChanged?.("/cwd");
    });

    await waitFor(() => {
      expect(window.electronAPI.fs.readDir).toHaveBeenCalledTimes(2);
    });
  });

  it("AC-L3-03-4: FilesPanel watch — subscribes to fs:changed when visible", () => {
    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);
    expect(window.electronAPI.fs.onChanged).toHaveBeenCalled();
  });
});

// ─── Access denied ────────────────────────────────────────────────────────────

describe("FilesPanel access denied", () => {
  it("AC-L3-03-N1: FilesPanel access denied — shows error when readDir fails", async () => {
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: false,
      error: "Access denied: /protected",
      data: [],
    });

    render(<FilesPanel isVisible={true} initialCwd="/protected" />);

    await waitFor(() => {
      expect(screen.getByTestId("files-error")).toBeInTheDocument();
    });
  });

  it("AC-L3-03-N1: FilesPanel access denied — error message visible", async () => {
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: false,
      error: "Access denied: /protected",
      data: [],
    });

    render(<FilesPanel isVisible={true} initialCwd="/protected" />);

    await waitFor(() => {
      const el = screen.getByTestId("files-error");
      expect(el.textContent).toContain("Access denied");
    });
  });
});

// ─── Preview ──────────────────────────────────────────────────────────────────

describe("Preview text", () => {
  it("AC-L3-04-1: Preview text — clicking a file shows preview", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("readme.txt")],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-entry-readme.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("file-entry-readme.txt"));

    expect(screen.getByTestId("files-preview")).toBeInTheDocument();
    expect(screen.getByTestId("files-preview-frame")).toBeInTheDocument();
  });

  it("AC-L3-04-1: Preview text — preview frame uses ezterm-file:// URL", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("readme.txt")],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-entry-readme.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("file-entry-readme.txt"));

    const frame = screen.getByTestId("files-preview-frame") as HTMLIFrameElement;
    expect(frame.src).toContain("ezterm-file://");
  });
});

describe("Preview image", () => {
  it("AC-L3-04-2: Preview image — image files show preview frame", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.fs.readDir).mockResolvedValue({
      ok: true,
      data: [makeEntry("photo.png")],
    });

    render(<FilesPanel isVisible={true} initialCwd="/cwd" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-entry-photo.png")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("file-entry-photo.png"));
    expect(screen.getByTestId("files-preview-frame")).toBeInTheDocument();
  });
});
