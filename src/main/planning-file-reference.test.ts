import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readPlanningFileReference } from './planning-file-reference';

const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it('reads the exact reviewed UTF-8 source and rejects changed contents or a link outside the project', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezt-planning-context-')); owned.push(directory);
  const project = path.join(directory, 'project'); await fs.mkdir(project);
  const text = '검토된 파일만 컨텍스트에 포함합니다.';
  await fs.writeFile(path.join(project, 'spec.txt'), text);
  const reference = { kind: 'file' as const, id: 'spec', revision: 1, sourcePath: 'spec.txt', hash: createHash('sha256').update(text).digest('hex') };
  expect(await readPlanningFileReference(project, reference)).toBe(text);
  await fs.writeFile(path.join(project, 'spec.txt'), 'changed');
  await expect(readPlanningFileReference(project, reference)).rejects.toThrow(/changed/u);
  await fs.mkdir(path.join(directory, 'outside')); await fs.writeFile(path.join(directory, 'outside', 'spec.txt'), text);
  await fs.symlink(path.join(directory, 'outside'), path.join(project, 'linked'), 'junction');
  await expect(readPlanningFileReference(project, { ...reference, sourcePath: 'linked/spec.txt' })).rejects.toThrow(/escaped/u);
});
