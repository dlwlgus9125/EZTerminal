/**
 * FilesystemManager — T10 implementation.
 * readDir: list directory entries.
 * watch: chokidar watcher for CWD changes (add/remove/change).
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as chokidar from "chokidar";
import type { BrowserWindow } from "electron";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export class FilesystemManager {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw Object.assign(new Error(`Access denied: ${dirPath}`), { code: "EACCES" });
      }
      throw err;
    }

    const results: DirEntry[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      let size = 0;
      let modifiedAt = 0;
      try {
        const stat = await fs.stat(fullPath);
        size = stat.isFile() ? stat.size : 0;
        modifiedAt = stat.mtimeMs;
      } catch {
        // skip unreadable entries
      }
      results.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        size,
        modifiedAt,
      });
    }
    return results;
  }

  watch(dirPath: string): void {
    this.stopWatch();
    this.watcher = chokidar.watch(dirPath, {
      depth: 0,
      ignoreInitial: true,
      persistent: false,
    });

    const notify = () => {
      this.getWindow()?.webContents.send("fs:changed", dirPath);
    };

    this.watcher.on("add", notify);
    this.watcher.on("unlink", notify);
    this.watcher.on("change", notify);
    this.watcher.on("addDir", notify);
    this.watcher.on("unlinkDir", notify);
  }

  stopWatch(): void {
    if (this.watcher === null) return;
    this.watcher.close().catch(() => {});
    this.watcher = null;
  }

  dispose(): void {
    this.stopWatch();
  }
}
