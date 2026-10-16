import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PLANNING_ASSET_MAX_BYTES, PlanningAssetRequestSchema, type PlanningAssetResult } from '../shared/planning-asset';
import type { PlanningService } from './planning-service';

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'font/woff': 'woff', 'font/woff2': 'woff2' };
function verifyBytes(bytes: Buffer, mime: string): void {
  if (!bytes.length || bytes.length > PLANNING_ASSET_MAX_BYTES) throw new Error('Assets must be between 1 byte and 512 KiB.');
  const head = bytes.subarray(0, 12);
  const valid = mime === 'image/png' ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? head[0] === 255 && head[1] === 216 && head[2] === 255
      : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'))
        : mime === 'image/webp' ? head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP'
          : mime === 'font/woff' ? head.subarray(0, 4).toString('ascii') === 'wOFF'
            : mime === 'font/woff2' && head.subarray(0, 4).toString('ascii') === 'wOF2';
  if (!valid) throw new Error('The file signature does not match a supported image or font.');
}

/** Immutable content-addressed files. Staging never changes the reviewed planning document. */
export class PlanningAssetService {
  constructor(private readonly options: {
    readonly planning: Pick<PlanningService, 'read'>;
    readonly resolveProjectRoot: (projectId: string) => string | null | undefined | Promise<string | null | undefined>;
    readonly ownsSubproject?: (projectId: string, subprojectId: string, writing: boolean) => Promise<boolean>;
  }) {}

  private async ownedPath(projectId: string, relativePath: string, create: boolean): Promise<string> {
    const registered = await this.options.resolveProjectRoot(projectId);
    if (!registered) throw new Error('The project is unavailable.');
    const root = await fs.realpath(registered);
    const parts = relativePath.replace(/\\/gu, '/').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':')) || path.isAbsolute(relativePath)) throw new Error('Invalid asset path.');
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      if (create && index < parts.length - 1) await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (create && index === parts.length - 1 && error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink() || (stat && (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))) throw new Error('Asset links and non-regular files are not supported.');
      if (stat) {
        const actual = await fs.realpath(current);
        const relative = path.relative(root, actual);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('The asset is outside its project.');
      }
    }
    return current;
  }

  async request(value: unknown): Promise<PlanningAssetResult> {
    const parsed = PlanningAssetRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, message: 'Invalid asset request.' };
    try {
      const request = parsed.data;
      if (request.subprojectId && !await this.options.ownsSubproject?.(request.projectId, request.subprojectId, request.type === 'stage')) throw new Error('The subproject is unavailable.');
      const planning = await this.options.planning.read(request.projectId, request.subprojectId);
      if (!planning.ok) throw new Error(planning.message);
      if (request.type === 'read') {
        const source = request.baselineId ? planning.snapshot.baselines.find(entry => entry.id === request.baselineId)?.draft : planning.snapshot.draft;
        const asset = source?.assets.find(entry => entry.id === request.assetId);
        if (!asset) throw new Error('This asset is not present in the selected planning version.');
        const filename = await this.ownedPath(request.projectId, asset.relativePath, false);
        const stat = await fs.stat(filename);
        if (stat.size !== asset.byteLength || stat.size > PLANNING_ASSET_MAX_BYTES) throw new Error('The asset size changed or exceeds 512 KiB.');
        const bytes = await fs.readFile(filename);
        if (digest(bytes) !== asset.hash) throw new Error('The asset contents changed after registration.');
        verifyBytes(bytes, asset.mimeType);
        return { ok: true, asset, dataBase64: bytes.toString('base64') };
      }
      const bytes = Buffer.from(request.dataBase64, 'base64');
      if (bytes.toString('base64') !== request.dataBase64) throw new Error('Invalid asset encoding.');
      verifyBytes(bytes, request.mimeType);
      const hash = digest(bytes);
      const relativePath = `.ezterminal/planning/assets/${hash}.${extensions[request.mimeType]}`;
      const filename = await this.ownedPath(request.projectId, relativePath, true);
      try {
        const handle = await fs.open(filename, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.ownedPath(request.projectId, relativePath, false);
        const existing = await fs.readFile(filename);
        if (!existing.equals(bytes)) throw new Error('The immutable asset file has different contents.');
      }
      return { ok: true, asset: { id: request.assetId, revision: planning.snapshot.draft.assets.find(entry => entry.id === request.assetId)?.revision ?? 0,
        title: request.title, hash, relativePath, mimeType: request.mimeType, byteLength: bytes.length } };
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The asset is unavailable.' }; }
  }
}
