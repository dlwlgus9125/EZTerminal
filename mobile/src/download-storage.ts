import { registerPlugin } from '@capacitor/core';

import { DOWNLOAD_MAX_FILE_BYTES, FILE_CHUNK_BYTES } from '../../src/shared/files';
import { uint8ArrayToBase64 } from '../../src/shared/remote-protocol';

export interface SavedDownload {
  readonly name: string;
  readonly uri: string;
}

export interface EZTerminalDownloadsPlugin {
  beginFile(options: {
    readonly name: string;
    readonly expectedBytes: number;
  }): Promise<{ readonly transferId: string }>;
  writeChunk(options: {
    readonly transferId: string;
    readonly data: string;
  }): Promise<{ readonly receivedBytes: number }>;
  commitFile(options: { readonly transferId: string }): Promise<SavedDownload>;
  abortFile(options: { readonly transferId: string }): Promise<void>;
}

const nativeDownloads = registerPlugin<EZTerminalDownloadsPlugin>('EZTerminalDownloads');

/** Stores a remote file in Android's scoped MediaStore Downloads collection.
 * This avoids legacy `/sdcard/Documents` path access, which is not writable
 * by a targetSdk 35 app on a fresh Android 10 device. */
export async function saveDownloadToDevice(
  name: string,
  bytes: Uint8Array,
  plugin: EZTerminalDownloadsPlugin = nativeDownloads,
): Promise<SavedDownload> {
  if (bytes.length > DOWNLOAD_MAX_FILE_BYTES) {
    throw new Error(`file exceeds the ${DOWNLOAD_MAX_FILE_BYTES}-byte download limit`);
  }

  const { transferId } = await plugin.beginFile({ name, expectedBytes: bytes.length });
  try {
    for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + FILE_CHUNK_BYTES, bytes.length));
      const acknowledgement = await plugin.writeChunk({
        transferId,
        data: uint8ArrayToBase64(chunk),
      });
      const expectedReceivedBytes = offset + chunk.length;
      if (acknowledgement.receivedBytes !== expectedReceivedBytes) {
        throw new Error(
          `native download acknowledgement mismatch: expected ${expectedReceivedBytes}, got ${acknowledgement.receivedBytes}`,
        );
      }
    }
    return await plugin.commitFile({ transferId });
  } catch (error) {
    try {
      await plugin.abortFile({ transferId });
    } catch {
      // Preserve the original bridge/storage failure. Native abort is
      // idempotent and also runs from the plugin lifecycle teardown.
    }
    throw error;
  }
}
