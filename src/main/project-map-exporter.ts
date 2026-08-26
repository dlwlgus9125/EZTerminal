import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import type {
  ProjectMapDocument,
  ProjectMapExportRequest,
  ProjectMapExportResult,
} from '../shared/project-map';
import { serializeProjectMapSvg } from '../shared/project-map-scene';

const EXPORT_WIDTH = 1600;
const EXPORT_HEIGHT = 900;

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function entersAuthoritativeDirectory(value: string): boolean {
  const parts = path.resolve(value).split(path.sep).map((part) => part.toLocaleLowerCase('en-US'));
  return parts.some((part, index) => part === '.ezterminal' && parts[index + 1] === 'project-map');
}

async function renderPng(svg: string): Promise<Buffer> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${EXPORT_WIDTH}px;height:${EXPORT_HEIGHT}px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;
  const win = new BrowserWindow({
    show: false,
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    useContentSize: true,
    backgroundColor: '#07110d',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      backgroundThrottling: false,
    },
  });
  try {
    await win.loadURL(`data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: EXPORT_WIDTH, height: EXPORT_HEIGHT });
    return image.toPNG();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export async function exportProjectMap(
  request: ProjectMapExportRequest,
  document: ProjectMapDocument,
  currentTheme: 'light' | 'dark',
): Promise<ProjectMapExportResult> {
  if (request.fingerprint !== document.verification.fingerprint) {
    return { ok: false, error: 'fingerprint-mismatch' };
  }
  if (!path.isAbsolute(request.parentDirectory) || entersAuthoritativeDirectory(request.parentDirectory)) {
    return { ok: false, error: 'invalid-export-directory' };
  }
  let parent: string;
  try {
    parent = await fs.realpath(request.parentDirectory);
  } catch {
    return { ok: false, error: 'export-parent-unavailable' };
  }
  if (entersAuthoritativeDirectory(parent)) return { ok: false, error: 'invalid-export-directory' };
  const shortFingerprint = request.fingerprint.slice(7, 19);
  const folderName = `${document.mapId}-${shortFingerprint}`;
  const destination = path.join(parent, folderName);
  const staging = path.join(parent, `.project-map-export-${randomUUID()}.tmp`);
  try {
    await fs.access(destination);
    return { ok: false, error: 'export-destination-exists' };
  } catch {
    // Expected: an export never overwrites an existing receipt directory.
  }
  const theme = request.theme === 'current' ? currentTheme : request.theme;
  const { svg, palette } = serializeProjectMapSvg(document, theme, {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
  });
  const png = await renderPng(svg);
  const svgName = `${document.mapId}.svg`;
  const pngName = `${document.mapId}.png`;
  const receiptName = `${document.mapId}.verification.json`;
  const receipt = {
    schemaVersion: 1,
    mapId: document.mapId,
    collectionId: document.collectionId,
    fingerprint: document.verification.fingerprint,
    exportedAt: new Date().toISOString(),
    viewport: { width: EXPORT_WIDTH, height: EXPORT_HEIGHT },
    theme,
    paletteHash: sha256(JSON.stringify(palette)),
    artifacts: {
      [svgName]: sha256(svg),
      [pngName]: sha256(png),
    },
    verification: document.verification,
    provenance: document.provenance,
  };
  try {
    await fs.mkdir(staging, { recursive: false });
    await Promise.all([
      fs.writeFile(path.join(staging, svgName), svg, { encoding: 'utf8', flag: 'wx' }),
      fs.writeFile(path.join(staging, pngName), png, { flag: 'wx' }),
      fs.writeFile(path.join(staging, receiptName), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    ]);
    await fs.rename(staging, destination);
    return {
      ok: true,
      directory: destination,
      files: [path.join(destination, svgName), path.join(destination, pngName), path.join(destination, receiptName)],
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : 'export-failed' };
  }
}
