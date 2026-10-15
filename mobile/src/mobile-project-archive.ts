import { ARCHIVE_MAX_BYTES, type ProjectArchiveRequest, type ProjectArchiveResult } from '../../src/shared/project-archive';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';
import { saveDownloadToDevice, type SavedDownload } from './download-storage';

type ArchiveTransport = Pick<WsEzTerminalTransport, 'executeProjectArchive' | 'uploadFile' | 'downloadFile'>;
function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error('The selected archive could not be read.'));
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(new Uint8Array(reader.result)) : reject(new Error('The selected archive returned no bytes.'));
    reader.readAsArrayBuffer(file);
  });
}
export function chooseProjectArchiveFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.ezarchive.json,.json,application/json'; input.hidden = true;
    let settled = false;
    const finish = (file: File | null) => { if (settled) return; settled = true; window.removeEventListener('focus', onFocus); input.remove(); resolve(file); };
    const onFocus = () => { window.setTimeout(() => { if (!settled && !input.files?.length) finish(null); }, 500); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    window.addEventListener('focus', onFocus); document.body.appendChild(input); input.click();
  });
}

/** Android's archive picker/transfer uses the existing chunked file and scoped MediaStore boundaries. */
export function mobileProjectArchiveAccess(transport: ArchiveTransport, options: {
  chooseFile?: () => Promise<File | null>;
  saveFile?: (name: string, bytes: Uint8Array) => Promise<SavedDownload>;
} = {}) {
  return { async executeProjectArchive(request: ProjectArchiveRequest): Promise<ProjectArchiveResult> {
    try {
      if (request.type === 'inspect' && !request.uploadedPath) {
        if (!request.projectId) return { ok: false, error: 'invalid-request', message: 'Select a project before importing its archive.' };
        const file = await (options.chooseFile ?? chooseProjectArchiveFile)();
        if (!file) return { ok: false, error: 'cancelled', message: 'Archive selection cancelled.' };
        if (file.size > ARCHIVE_MAX_BYTES) return { ok: false, error: 'invalid-request', message: 'Project archives must be 50 MiB or smaller. The original file was preserved.' };
        const prepared = await transport.executeProjectArchive({ type: 'prepare-import', projectId: request.projectId });
        if (!prepared.ok) return prepared;
        if (prepared.kind !== 'prepare-import') throw new Error('The PC did not return an archive inbox.');
        const uploaded = await transport.uploadFile(prepared.directoryPath, file.name, await readFileBytes(file), () => undefined);
        const separator = prepared.directoryPath.endsWith('/') || prepared.directoryPath.endsWith('\\') ? '' : '/';
        return transport.executeProjectArchive({ ...request, uploadedPath: `${prepared.directoryPath}${separator}${uploaded.finalName}` });
      }
      const result = await transport.executeProjectArchive(request);
      if (result.ok && result.kind === 'export') {
        const downloaded = await transport.downloadFile(result.path, () => undefined);
        const saved = await (options.saveFile ?? saveDownloadToDevice)(downloaded.name, downloaded.bytes);
        return { ...result, path: saved.uri };
      }
      return result;
    } catch (error) { return { ok: false, error: 'unavailable', message: error instanceof Error ? error.message : 'The archive transfer failed. The original records were preserved.' }; }
  } };
}
