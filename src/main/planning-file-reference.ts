import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlanningReference } from '../shared/planning';

/** Resolve reviewed text from the registered project, with the same boundary in planning and execution. */
export async function readPlanningFileReference(root: string, reference: PlanningReference): Promise<string> {
  if (reference.kind !== 'file' || !reference.sourcePath || !reference.hash) throw new Error('File context needs a reviewed path and content hash.');
  const actualRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(actualRoot, reference.sourcePath));
  const relative = path.relative(actualRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('File context escaped the registered project.');
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('File context must be a text file of at most 64 KiB.');
  const bytes = await fs.readFile(target);
  if (createHash('sha256').update(bytes).digest('hex') !== reference.hash || bytes.includes(0)) throw new Error('File context changed or is not plain text. Refresh its reviewed reference.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
