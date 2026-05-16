import path from "node:path";
import { BrowserWindow, app, ipcMain, protocol } from "electron";
import { FileProtocolHandler } from "./file-protocol";
import { FilesystemManager } from "./filesystem";
import { FrameBuffer } from "./frame-buffer";
import { MetricsCollector } from "./metrics";
import { NetworkCollector } from "./network";
import { PtyManager } from "./pty-manager";
import { SettingsManager } from "./settings";

// Handle squirrel events on Windows (optional in dev/test mode)
try {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require for optional module
  if ((require as (id: string) => any)("electron-squirrel-startup")) {
    app.quit();
  }
} catch {
  // electron-squirrel-startup not available in dev/test — continue
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();
const frameBuffer = new FrameBuffer();
const metricsCollector = new MetricsCollector(() => mainWindow);
const networkCollector = new NetworkCollector(() => mainWindow);
const filesystemManager = new FilesystemManager(() => mainWindow);
const settingsPath = path.join(app.getPath("userData"), "settings.json");
const settingsManager = new SettingsManager(settingsPath);
const fileProtocolHandler = new FileProtocolHandler(process.cwd());

function registerIpcHandlers(): void {
  // Coalesced PTY data → push to renderer
  frameBuffer.onFlush((sessionId, data) => {
    mainWindow?.webContents.send(`pty:data:${sessionId}`, data);
  });

  // pty:create — spawn new PTY session
  ipcMain.handle(
    "pty:create",
    async (_event, opts: { cols: number; rows: number; shell?: string }) => {
      const result = await ptyManager.create(opts);
      if (result.ok) {
        const pty = ptyManager.getSession(result.data);
        if (pty) {
          pty.onData((data: string) => {
            frameBuffer.push(result.data, data);
          });
          pty.onExit(({ exitCode }) => {
            frameBuffer.endSession(result.data);
            mainWindow?.webContents.send(`pty:exit:${result.data}`, exitCode);
          });
        }
      }
      return result;
    }
  );

  // pty:write — write to PTY stdin
  ipcMain.on("pty:write", (_event, id: string, data: string) => {
    const pty = ptyManager.getSession(id);
    if (!pty) return;
    pty.write(data);
  });

  // pty:resize — resize PTY
  ipcMain.on("pty:resize", (_event, id: string, cols: number, rows: number) => {
    const pty = ptyManager.getSession(id);
    if (!pty) return;
    pty.resize(cols, rows);
  });

  // pty:kill — terminate PTY session
  ipcMain.handle("pty:kill", (_event, id: string) => {
    ptyManager.kill(id);
  });

  // metrics:start — begin 2s SI polling
  ipcMain.on("metrics:start", () => {
    metricsCollector.start();
  });

  // metrics:stop — stop polling
  ipcMain.on("metrics:stop", () => {
    metricsCollector.stop();
  });

  // network:start — begin SI polling + optional cap capture
  ipcMain.on("network:start", () => {
    networkCollector.start();
  });

  // network:stop — stop polling + capture
  ipcMain.on("network:stop", () => {
    networkCollector.stop();
  });

  // settings:load — load user settings from disk
  ipcMain.handle("settings:load", async () => {
    try {
      const settings = await settingsManager.load();
      return { ok: true, data: settings };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // settings:save — atomic save user settings
  ipcMain.handle("settings:save", async (_event, settings) => {
    try {
      if (!settingsManager.validate(settings)) {
        return { ok: false, error: "Invalid settings" };
      }
      await settingsManager.save(settings);
      mainWindow?.webContents.send("settings:applied", settings);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // fs:readDir — list directory entries
  ipcMain.handle("fs:readDir", async (_event, dirPath: string) => {
    try {
      const entries = await filesystemManager.readDir(dirPath);
      return { ok: true, data: entries };
    } catch (err: unknown) {
      return { ok: false, error: String(err) };
    }
  });

  // fs:watch — start chokidar watch on dirPath
  ipcMain.on("fs:watch", (_event, dirPath: string) => {
    filesystemManager.watch(dirPath);
    fileProtocolHandler.setCwd(dirPath);
  });

  // fs:stopWatch — stop chokidar watch
  ipcMain.on("fs:stopWatch", () => {
    filesystemManager.stopWatch();
  });
}

function registerProtocols(): void {
  // ezterm-file:// — serve local files scoped to CWD
  protocol.handle("ezterm-file", async (request) => {
    const url = new URL(request.url);
    // Decode the path from the URL (hostname + pathname combined)
    const rawPath = decodeURIComponent(url.hostname + url.pathname);
    const result = await fileProtocolHandler.serve(rawPath);
    if ("error" in result) {
      return new Response(result.error, { status: 403 });
    }
    return new Response(result.data, {
      headers: { "Content-Type": result.mimeType },
    });
  });
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "../preload/index.js");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    frame: false,
    backgroundColor: "#0a0d0c",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerProtocols();
  registerIpcHandlers();
  createWindow();
  ptyManager.startOrphanScan();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  metricsCollector.stop();
  networkCollector.stop();
  filesystemManager.dispose();
  ptyManager.stopOrphanScan();
  ptyManager.killAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
