import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether a program holds the folder open. Windows will not rename a folder a process works in or
 * has a file open in, while git would delete what it can and leave half a worktree behind.
 */
export async function folderHeld(folder: string): Promise<boolean> {
  const aside = `${folder}.cleanup-${randomUUID().slice(0, 8)}`;
  try {
    await fs.rename(folder, aside);
  } catch (error) {
    return ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
  try {
    await fs.rename(aside, folder);
  } catch (error) {
    throw new Error(`The worktree folder was moved to ${aside} for a check and could not be moved back; rename it to ${folder}. ${error instanceof Error ? error.message : ''}`.trim());
  }
  return false;
}

/** Whether the folder is gone or holds nothing but empty folders. */
export async function onlyEmptyFolders(folder: string): Promise<boolean> {
  try {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || !(await onlyEmptyFolders(path.join(folder, entry.name)))) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Deletes a folder only if nothing but empty folders is in it (true when it is gone). Files and links are never touched. */
export async function removeEmptyFolders(folder: string): Promise<boolean> {
  try {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await removeEmptyFolders(path.join(folder, entry.name));
    }
    await fs.rmdir(folder);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
