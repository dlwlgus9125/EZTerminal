import { app } from 'electron';
import path from 'node:path';

/** Resolve the one native desktop helper used by service, transport, and
 * process-guardian modes. Keeping this in one place prevents packaged and
 * development lifecycle paths from drifting apart. */
export function resolveNativeHostPath(): string {
  return process.env.EZTERMINAL_REMOTE_HOST_PATH
    ?? (app.isPackaged
      ? path.join(process.resourcesPath, 'ezterminal-remote-host.exe')
      : path.join(
          path.resolve(__dirname, '..', '..'),
          'native',
          'remote-host',
          'target',
          'release',
          'ezterminal-remote-host.exe',
        ));
}
