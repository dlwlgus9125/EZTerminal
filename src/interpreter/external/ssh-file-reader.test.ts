import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SSH_PRIVATE_KEY_MAX_BYTES,
  readSshPrivateKeyFile,
} from './ssh-file-reader';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ezterminal-ssh-file-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readSshPrivateKeyFile', () => {
  it('reads a bounded regular private key', async () => {
    const keyPath = join(root, 'id_ed25519');
    const key = Buffer.from('small-private-key');
    await writeFile(keyPath, key);

    await expect(readSshPrivateKeyFile(keyPath)).resolves.toEqual(key);
  });

  it('rejects an oversized private key before parsing it', async () => {
    const keyPath = join(root, 'oversized-key');
    const handle = await open(keyPath, 'w');
    try {
      await handle.truncate(SSH_PRIVATE_KEY_MAX_BYTES + 1);
    } finally {
      await handle.close();
    }

    await expect(readSshPrivateKeyFile(keyPath)).rejects.toThrow(/exceeds 1048576 bytes/);
  });

  it('fails closed for a private-key symlink', async () => {
    const target = join(root, 'target-key');
    const link = join(root, 'linked-key');
    await writeFile(target, 'small-private-key');
    await symlink(target, link, 'file');

    await expect(readSshPrivateKeyFile(link)).rejects.toThrow(/symbolic link|reparse point/i);
  });
});
