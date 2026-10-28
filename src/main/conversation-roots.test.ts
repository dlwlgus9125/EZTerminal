import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonProject, DaemonWorkspace } from '../shared/daemon-protocol';
import { createConversationFolderResolver, isDirectory, resolveConversationFolders } from './conversation-roots';

const NOW = '2026-10-22T00:00:00.000Z';
const MAIN = 'C:\\Work\\app';
const SHARED = 'C:\\Work\\shared';
const DOCS = 'C:\\Work\\docs';
const everyFolder = async (): Promise<boolean> => true;

function workspace(id: string, rootPath: string, extra: Partial<DaemonWorkspace> = {}): DaemonWorkspace {
  return { id, projectId: 'project', name: id, kind: 'local', rootPath, revision: 1, createdAt: NOW, updatedAt: NOW, ...extra };
}

const project: DaemonProject = { id: 'project', name: 'App', rootPath: MAIN, source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW };

describe('resolveConversationFolders', () => {
  it('puts the working folder first and the other registered folders after it, in order', async () => {
    await expect(resolveConversationFolders({ registeredRoots: [MAIN, SHARED, DOCS], workspaceRoot: SHARED }, everyFolder))
      .resolves.toEqual({ primary: SHARED, additional: [MAIN, DOCS], missing: [] });
  });

  it('leaves out the folder a worktree was made from', async () => {
    await expect(resolveConversationFolders({
      registeredRoots: [MAIN, SHARED], workspaceRoot: 'C:\\Work\\app-trees\\feature', sourceRoot: MAIN,
    }, everyFolder)).resolves.toEqual({ primary: 'C:\\Work\\app-trees\\feature', additional: [SHARED], missing: [] });
  });

  it('reports folders that are not directories as missing instead of passing them on', async () => {
    const present = async (folderPath: string): Promise<boolean> => folderPath !== DOCS;
    await expect(resolveConversationFolders({ registeredRoots: [MAIN, SHARED, DOCS], workspaceRoot: MAIN }, present))
      .resolves.toEqual({ primary: MAIN, additional: [SHARED], missing: [DOCS] });
  });

  it('keeps a one-folder project to its working folder', async () => {
    await expect(resolveConversationFolders({ registeredRoots: [MAIN], workspaceRoot: MAIN }, everyFolder))
      .resolves.toEqual({ primary: MAIN, additional: [], missing: [] });
  });

  it.runIf(process.platform === 'win32')('treats folders that differ only in case or a trailing slash as one', async () => {
    await expect(resolveConversationFolders({
      registeredRoots: ['c:\\work\\APP', SHARED, 'C:\\Work\\Shared\\'], workspaceRoot: MAIN,
    }, everyFolder)).resolves.toEqual({ primary: MAIN, additional: [SHARED], missing: [] });
  });
});

describe('isDirectory', () => {
  let temp: string | undefined;
  afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = undefined; });

  it('is true for a directory and false for a missing path', async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'ez-roots-'));
    await mkdir(path.join(temp, 'there'));
    await expect(isDirectory(path.join(temp, 'there'))).resolves.toBe(true);
    await expect(isDirectory(path.join(temp, 'gone'))).resolves.toBe(false);
  });
});

describe('createConversationFolderResolver', () => {
  const resolver = createConversationFolderResolver({
    registeredRoots: (projectId) => (projectId === 'project' ? [MAIN, SHARED, DOCS] : undefined),
    isDirectory: everyFolder,
  });
  const snapshot = {
    projects: [project],
    workspaces: [
      workspace('main', MAIN),
      workspace('shared', SHARED),
      workspace('tree', 'C:\\Work\\app-trees\\feature', { kind: 'worktree', sourceWorkspaceId: 'main' }),
      workspace('archived', DOCS, { archivedAt: NOW }),
    ],
  };

  it('resolves a workspace of the project', async () => {
    await expect(resolver(snapshot, { projectId: 'project', workspaceId: 'shared' }))
      .resolves.toEqual({ primary: SHARED, additional: [MAIN], missing: [] });
  });

  it('replaces the source folder with the worktree', async () => {
    await expect(resolver(snapshot, { projectId: 'project', workspaceId: 'tree' }))
      .resolves.toEqual({ primary: 'C:\\Work\\app-trees\\feature', additional: [SHARED], missing: [] });
  });

  it('leaves out a folder whose workspace the snapshot already archived, though the store still lists it', async () => {
    // A project save archives the removed folder's workspace first and commits the project store after.
    await expect(resolver(snapshot, { projectId: 'project', workspaceId: 'main' }))
      .resolves.toEqual({ primary: MAIN, additional: [SHARED], missing: [] });
    const readded = { ...snapshot, workspaces: [...snapshot.workspaces, workspace('docs-again', DOCS)] };
    await expect(resolver(readded, { projectId: 'project', workspaceId: 'main' }))
      .resolves.toEqual({ primary: MAIN, additional: [SHARED, DOCS], missing: [] });
  });

  it('answers nothing for an archived or foreign workspace', async () => {
    await expect(resolver(snapshot, { projectId: 'project', workspaceId: 'archived' })).resolves.toBeUndefined();
    await expect(resolver(snapshot, { projectId: 'other', workspaceId: 'main' })).resolves.toBeUndefined();
  });

  it('gives only the working folder when the project has no registered folders', async () => {
    const bare = createConversationFolderResolver({ registeredRoots: () => undefined, isDirectory: everyFolder });
    await expect(bare(snapshot, { projectId: 'project', workspaceId: 'main' }))
      .resolves.toEqual({ primary: MAIN, additional: [], missing: [] });
  });
});
