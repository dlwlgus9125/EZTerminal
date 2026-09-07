import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** Shell launch discovery deliberately does not probe SDK versions or authentication. */
export function terminalCliInstalled(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32';
  const searchPath = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const extensions = windows ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const directory of searchPath.split(windows ? ';' : ':')) {
    // Do not count an executable found implicitly in an arbitrary current directory.
    if (!directory.trim()) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/gu, ''), `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch { /* Continue searching the shell's PATH. */ }
    }
  }
  return false;
}
