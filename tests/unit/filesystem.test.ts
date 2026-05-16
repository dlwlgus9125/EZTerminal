/**
 * Unit tests for FilesystemManager [R-L3-03, R-L3-04]
 * AC-L3-03-3: file tree listing
 * AC-L3-03-4: realtime watch via chokidar
 * AC-L3-03-N1: access denied error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock node:fs/promises ---
const mockReaddir = vi.fn();
const mockStat = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: mockReaddir,
    stat: mockStat,
  },
  readdir: mockReaddir,
  stat: mockStat,
}));

// --- Mock chokidar ---
const mockWatcherOn = vi.fn();
const mockWatcherClose = vi.fn().mockResolvedValue(undefined);
const mockWatch = vi.fn(() => ({
  on: mockWatcherOn,
  close: mockWatcherClose,
}));

vi.mock("chokidar", () => ({
  watch: mockWatch,
}));

const { FilesystemManager } = await import("../../src/main/filesystem");

function makeWindow() {
  const send = vi.fn();
  return { webContents: { send } } as unknown as Electron.BrowserWindow;
}

function makeDirent(name: string, isDir = false) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

function makeStat(size = 100, mtimeMs = 0) {
  return { size, mtimeMs, isFile: () => true };
}

describe("FilesystemManager readDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC-L3-03-3: FilesPanel tree — returns DirEntry array for valid directory", async () => {
    mockReaddir.mockResolvedValue([makeDirent("file.txt"), makeDirent("subdir", true)]);
    mockStat.mockResolvedValue(makeStat(42));

    const mgr = new FilesystemManager(() => null);
    const entries = await mgr.readDir("/some/dir");

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("file.txt");
    expect(entries[0].isDirectory).toBe(false);
    expect(entries[0].size).toBe(42);
    expect(entries[1].name).toBe("subdir");
    expect(entries[1].isDirectory).toBe(true);
  });

  it("AC-L3-03-3: FilesPanel tree — empty directory returns empty array", async () => {
    mockReaddir.mockResolvedValue([]);
    const mgr = new FilesystemManager(() => null);
    const entries = await mgr.readDir("/empty");
    expect(entries).toHaveLength(0);
  });

  it("AC-L3-03-N1: FilesPanel access denied — throws EACCES on denied directory", async () => {
    const err = Object.assign(new Error("Access denied"), { code: "EACCES" });
    mockReaddir.mockRejectedValue(err);
    const mgr = new FilesystemManager(() => null);
    await expect(mgr.readDir("/denied")).rejects.toThrow("Access denied");
  });

  it("AC-L3-03-N1: FilesPanel access denied — throws EPERM as access denied", async () => {
    const err = Object.assign(new Error("Permission denied"), { code: "EPERM" });
    mockReaddir.mockRejectedValue(err);
    const mgr = new FilesystemManager(() => null);
    await expect(mgr.readDir("/denied")).rejects.toThrow();
  });

  it("stat errors are silently skipped per entry", async () => {
    mockReaddir.mockResolvedValue([makeDirent("file.txt")]);
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const mgr = new FilesystemManager(() => null);
    const entries = await mgr.readDir("/dir");
    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(0);
  });
});

describe("FilesystemManager watch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcherOn.mockReturnValue({ on: mockWatcherOn, close: mockWatcherClose });
  });

  it("AC-L3-03-4: FilesPanel watch — starts chokidar watcher on dirPath", () => {
    const mgr = new FilesystemManager(() => null);
    mgr.watch("/some/dir");
    expect(mockWatch).toHaveBeenCalledWith("/some/dir", expect.objectContaining({ depth: 0 }));
  });

  it("AC-L3-03-4: FilesPanel watch — sends fs:changed on file add", () => {
    const win = makeWindow();
    const mgr = new FilesystemManager(() => win);
    mgr.watch("/some/dir");

    // Find and trigger the 'add' handler
    const addCall = mockWatcherOn.mock.calls.find((c) => c[0] === "add");
    expect(addCall).toBeDefined();
    addCall?.[1]();
    expect(win.webContents.send).toHaveBeenCalledWith("fs:changed", "/some/dir");
  });

  it("AC-L3-03-4: FilesPanel watch — sends fs:changed on file unlink", () => {
    const win = makeWindow();
    const mgr = new FilesystemManager(() => win);
    mgr.watch("/some/dir");

    const unlinkCall = mockWatcherOn.mock.calls.find((c) => c[0] === "unlink");
    expect(unlinkCall).toBeDefined();
    unlinkCall?.[1]();
    expect(win.webContents.send).toHaveBeenCalledWith("fs:changed", "/some/dir");
  });

  it("stopWatch closes the watcher", async () => {
    const mgr = new FilesystemManager(() => null);
    mgr.watch("/dir");
    mgr.stopWatch();
    expect(mockWatcherClose).toHaveBeenCalled();
  });

  it("stopWatch is a no-op when no watcher active", () => {
    const mgr = new FilesystemManager(() => null);
    expect(() => mgr.stopWatch()).not.toThrow();
  });

  it("watch replaces existing watcher", () => {
    const mgr = new FilesystemManager(() => null);
    mgr.watch("/dir1");
    mgr.watch("/dir2");
    expect(mockWatch).toHaveBeenCalledTimes(2);
    expect(mockWatcherClose).toHaveBeenCalledTimes(1);
  });
});
