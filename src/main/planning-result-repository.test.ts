import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanningResultRepository, type PlanningResultRecord, type PlanningResultRepositoryOptions } from './planning-result-repository';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function repository(): Promise<{ repository: PlanningResultRepository; userDataDir: string }> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-planning-result-'));
  directories.push(userDataDir);
  const options = { userDataDir, git: { run: vi.fn() }, worktrees: { execute: vi.fn() }, getSnapshot: vi.fn(), readTranscript: vi.fn() } as unknown as PlanningResultRepositoryOptions;
  return { repository: new PlanningResultRepository(options), userDataDir };
}

const record: PlanningResultRecord = {
  version: 1, projectId: 'P', runId: 'R', taskId: 'T', attemptId: 'A', baselineFingerprint: 'f'.repeat(64),
  rootPath: 'C:/project', artifacts: [{ artifactId: 'transcript:abc', revision: 0 }], changedPaths: [], validations: [],
};
const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe('PlanningResultRepository', () => {
  it('saves a result even when Windows briefly refuses the replace because the file is being read', async () => {
    const { repository: results } = await repository();
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => { throw refused('EPERM'); }).mockImplementation(rename);
    await results.saveResult(record);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await results.readResult('P', 'A')).toEqual(record);
  });

  it('still fails a write the system keeps refusing, and leaves no temporary file behind', async () => {
    const { repository: results, userDataDir } = await repository();
    vi.spyOn(fs, 'rename').mockImplementation(async () => { throw refused('EPERM'); });
    await expect(results.saveResult(record)).rejects.toThrow('EPERM');
    const folder = path.join(userDataDir, 'planning-results-v1', 'attempt');
    expect((await fs.readdir(folder)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
