import { describe, expect, it, vi } from 'vitest';

import { DOWNLOAD_MAX_FILE_BYTES, FILE_CHUNK_BYTES } from '../../src/shared/files';
import { base64ToUint8Array } from '../../src/shared/remote-protocol';
import {
  saveDownloadToDevice,
  type EZTerminalDownloadsPlugin,
} from './download-storage';

describe('Android download storage bridge', () => {
  it('streams exact bytes in bounded chunks and returns the MediaStore identity', async () => {
    const beginFile = vi.fn(async () => ({ transferId: 'transfer-42' }));
    let receivedBytes = 0;
    const writeChunk = vi.fn(async (options: { readonly transferId: string; readonly data: string }) => {
      receivedBytes += base64ToUint8Array(options.data).length;
      return { receivedBytes };
    });
    const commitFile = vi.fn(async () => ({
      name: 'report (1).txt',
      uri: 'content://media/external_primary/downloads/42',
    }));
    const abortFile = vi.fn(async () => undefined);
    const plugin: EZTerminalDownloadsPlugin = { beginFile, writeChunk, commitFile, abortFile };
    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 6);
    bytes.set([0, 1, 2], 0);
    bytes.set([253, 254, 255], FILE_CHUNK_BYTES + 3);

    await expect(saveDownloadToDevice(
      'report.txt',
      bytes,
      plugin,
    )).resolves.toEqual({
      name: 'report (1).txt',
      uri: 'content://media/external_primary/downloads/42',
    });
    expect(beginFile).toHaveBeenCalledWith({ name: 'report.txt', expectedBytes: bytes.length });
    expect(writeChunk).toHaveBeenCalledTimes(2);
    expect(writeChunk.mock.calls.map(([options]) => base64ToUint8Array(options.data).length))
      .toEqual([FILE_CHUNK_BYTES, 6]);
    expect(writeChunk.mock.calls.every(([options]) => options.transferId === 'transfer-42')).toBe(true);
    expect(commitFile).toHaveBeenCalledWith({ transferId: 'transfer-42' });
    expect(abortFile).not.toHaveBeenCalled();
  });

  it('commits an empty download without sending an empty chunk', async () => {
    const plugin: EZTerminalDownloadsPlugin = {
      beginFile: vi.fn(async () => ({ transferId: 'empty' })),
      writeChunk: vi.fn(async () => ({ receivedBytes: 0 })),
      commitFile: vi.fn(async () => ({ name: 'empty.txt', uri: 'content://empty' })),
      abortFile: vi.fn(async () => undefined),
    };

    await expect(saveDownloadToDevice('empty.txt', new Uint8Array(), plugin))
      .resolves.toEqual({ name: 'empty.txt', uri: 'content://empty' });
    expect(plugin.writeChunk).not.toHaveBeenCalled();
  });

  it('aborts the pending MediaStore row when a chunk acknowledgement is inconsistent', async () => {
    const abortFile = vi.fn(async () => undefined);
    const plugin: EZTerminalDownloadsPlugin = {
      beginFile: vi.fn(async () => ({ transferId: 'broken' })),
      writeChunk: vi.fn(async () => ({ receivedBytes: 1 })),
      commitFile: vi.fn(async () => ({ name: 'never', uri: 'content://never' })),
      abortFile,
    };

    await expect(saveDownloadToDevice('report.txt', new Uint8Array([1, 2]), plugin))
      .rejects.toThrow('acknowledgement mismatch');
    expect(abortFile).toHaveBeenCalledWith({ transferId: 'broken' });
    expect(plugin.commitFile).not.toHaveBeenCalled();
  });

  it('rejects an oversized buffer before creating a MediaStore row', async () => {
    const beginFile = vi.fn(async () => ({ transferId: 'never' }));
    const plugin: EZTerminalDownloadsPlugin = {
      beginFile,
      writeChunk: vi.fn(async () => ({ receivedBytes: 0 })),
      commitFile: vi.fn(async () => ({ name: 'never', uri: 'content://never' })),
      abortFile: vi.fn(async () => undefined),
    };
    const oversized = { length: DOWNLOAD_MAX_FILE_BYTES + 1 } as Uint8Array;

    await expect(saveDownloadToDevice('too-big.bin', oversized, plugin))
      .rejects.toThrow(`${DOWNLOAD_MAX_FILE_BYTES}-byte download limit`);
    expect(beginFile).not.toHaveBeenCalled();
  });
});
