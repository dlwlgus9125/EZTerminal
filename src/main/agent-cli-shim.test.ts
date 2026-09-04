import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentCliShim } from './agent-cli-shim';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('AgentCliShim', () => {
  it('installs the integrated CLI and the compatibility alias over the signed host', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-cli-shim-'));
    temporaryDirectories.push(userData);
    const shim = new AgentCliShim(userData, 'C:\\Program Files\\EZTerminal\\remote%host.exe');

    await shim.init();

    const expected = '@echo off\r\n"C:\\Program Files\\EZTerminal\\remote%%host.exe" --agent-control %*\r\n';
    await expect(fs.readFile(path.join(shim.directory, 'ezterminal.cmd'), 'utf8')).resolves.toBe(expected);
    await expect(fs.readFile(path.join(shim.directory, 'ezterminal-agent.cmd'), 'utf8')).resolves.toBe(expected);
  });
});
