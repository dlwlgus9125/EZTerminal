// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_GIT_DIRECTORY_STATUS, UNAVAILABLE_GIT_DIRECTORY_STATUS, type GitDirectoryStatus } from '../shared/git-status';
import { useNotARepository } from './use-git-branch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READY: GitDirectoryStatus = { availability: 'ready', tracked: true, changes: [], truncated: false };

let root: Root;
let answer: boolean | undefined;

function Probe({ directory, read, generation }: { readonly directory: string | undefined; readonly read: (directory: string) => Promise<GitDirectoryStatus>; readonly generation?: unknown }): null {
  answer = useNotARepository(directory, read, generation);
  return null;
}

async function show(directory: string | undefined, read: (directory: string) => Promise<GitDirectoryStatus>, generation?: unknown): Promise<void> {
  await act(async () => root.render(<Probe directory={directory} read={read} generation={generation} />));
}

beforeEach(() => {
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useNotARepository', () => {
  it('is true only when Git says the folder is not a repository', async () => {
    await show('C:\\kit', () => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS));
    expect(answer).toBe(true);
    await show('C:\\repo', () => Promise.resolve(READY));
    expect(answer).toBe(false);
  });

  it('rules nothing out on a status that failed or timed out: that says nothing about the repository', async () => {
    await show('C:\\big-repo', () => Promise.resolve(UNAVAILABLE_GIT_DIRECTORY_STATUS));
    expect(answer).toBe(false);
    await show('C:\\gone', () => Promise.reject(new Error('no host')));
    expect(answer).toBe(false);
    await show(undefined, () => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS));
    expect(answer).toBe(false);
  });

  it('asks again each generation: a turn can run git init', async () => {
    const read = vi.fn<(directory: string) => Promise<GitDirectoryStatus>>().mockResolvedValueOnce(EMPTY_GIT_DIRECTORY_STATUS).mockResolvedValue(READY);
    await show('C:\\kit', read, 'turn-1');
    expect(answer).toBe(true);
    await show('C:\\kit', read, 'turn-1');
    expect(read).toHaveBeenCalledTimes(1);
    await show('C:\\kit', read, undefined);
    expect(read).toHaveBeenCalledTimes(2);
    expect(answer).toBe(false);
  });

  it('never carries one folder’s answer to another', async () => {
    let finish: (status: GitDirectoryStatus) => void = () => undefined;
    await show('C:\\kit', () => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS));
    await show('C:\\repo', () => new Promise((resolve) => { finish = resolve; }));
    expect(answer).toBe(false);
    await act(async () => finish(READY));
    expect(answer).toBe(false);
  });
});
