import { clipboard } from 'electron';
import { sshForwardFailure, type SshForwardResult } from '../shared/ssh-forward';
import type { TerminalFileLocationRequest } from '../shared/terminal-file-location';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { LayoutStore } from './layout-store';
import { SshForwardService } from './ssh-forward-service';
import { readTerminalClipboardSnapshot, writeTerminalClipboardText } from './terminal-clipboard';
import { TerminalFileCapabilityStore } from './terminal-file-capability';
import { resolveTerminalFileLocation } from './terminal-path-resolver';

interface InstallTerminalToolsIpcOptions {
  readonly ipc: FeatureIpc;
  readonly OSC52_MAIN_MAX_BYTES: number;
  readonly storeReady: Promise<void>;
  readonly layoutStore: LayoutStore;
  readonly osc52LastWrite: WeakMap<object, number>;
  readonly OSC52_MAIN_MIN_INTERVAL_MS: 1000;
  readonly terminalCapabilitiesFor: (sender: object) => TerminalFileCapabilityStore;
  readonly sshForwardService: SshForwardService | null;
}

export function installTerminalToolsIpc(dependencies: InstallTerminalToolsIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('terminal:read-clipboard', () => readTerminalClipboardSnapshot(clipboard));
    ipcMain.handle('terminal:write-clipboard', (_event, text: unknown): boolean =>
      writeTerminalClipboardText(clipboard, text));
    ipcMain.handle('terminal:write-osc52-clipboard', async (event, text: unknown): Promise<boolean> => {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > dependencies.OSC52_MAIN_MAX_BYTES) return false;
      await dependencies.storeReady;
      if (!(await dependencies.layoutStore.getAllowOsc52Clipboard())) return false;
      const now = Date.now();
      const previous = dependencies.osc52LastWrite.get(event.sender) ?? Number.NEGATIVE_INFINITY;
      if (now - previous < dependencies.OSC52_MAIN_MIN_INTERVAL_MS) return false;
      dependencies.osc52LastWrite.set(event.sender, now);
      clipboard.writeText(text);
      return true;
    });
    ipcMain.handle('terminal:resolve-file-location', (event, request: TerminalFileLocationRequest) =>
      resolveTerminalFileLocation(request, dependencies.terminalCapabilitiesFor(event.sender)));
    ipcMain.handle('ssh-forwards:list', () => dependencies.sshForwardService?.listAll() ?? []);
    ipcMain.handle(
      'ssh-forwards:stop',
      async (_event, connectionId: unknown, forwardId: unknown): Promise<SshForwardResult> => {
        if (typeof connectionId !== 'string' || typeof forwardId !== 'string') {
          return sshForwardFailure(new Error('invalid SSH forward stop request'));
        }
        try {
          if (!dependencies.sshForwardService) throw new Error('SSH forwarding service is unavailable');
          return { ok: true, forwards: [await dependencies.sshForwardService.stop(connectionId, forwardId)] };
        } catch (error) {
          return sshForwardFailure(error);
        }
      },
    );
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
