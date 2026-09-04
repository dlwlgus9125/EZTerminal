import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Runtime-generated command shim; execution stays inside the signed native host. */
export class AgentCliShim {
  readonly directory: string;

  constructor(
    userDataDir: string,
    private readonly nativeHostPath: string,
  ) {
    this.directory = path.join(userDataDir, 'agent-cli');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const escapedHost = this.nativeHostPath.replaceAll('%', '%%');
    const contents = `@echo off\r\n"${escapedHost}" --agent-control %*\r\n`;
    for (const name of ['ezterminal.cmd', 'ezterminal-agent.cmd']) {
      const target = path.join(this.directory, name);
      const existing = await fs.readFile(target, 'utf8').catch(() => null);
      if (existing !== contents) {
        await fs.writeFile(target, contents, { encoding: 'utf8', flag: 'w' });
      }
    }
  }

  prependToPath(existing: string | undefined): string {
    const entries = (existing ?? '').split(path.delimiter).filter(Boolean);
    const key = process.platform === 'win32'
      ? this.directory.toLocaleLowerCase('en-US')
      : this.directory;
    const filtered = entries.filter((entry) => (
      (process.platform === 'win32' ? entry.toLocaleLowerCase('en-US') : entry) !== key
    ));
    return [this.directory, ...filtered].join(path.delimiter);
  }
}
