import path from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import { FrameBuffer } from "./frame-buffer";
import { PtyManager } from "./pty-manager";

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
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  ptyManager.killAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
