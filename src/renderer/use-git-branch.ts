import { useEffect, useState } from 'react';

import type { GitDirectoryStatus } from '../shared/git-status';

/**
 * Resolve the branch for each of a set of directories.
 *
 * Branch is not on any activity or session record — it is a property of the
 * directory, and the one authority for it is Git. Asking here rather than
 * widening a transport record keeps a fact that changes on checkout from being
 * cached inside a snapshot that has no idea when it went stale.
 *
 * Cheap by construction: `getGitStatus` caches for a couple of seconds, and a
 * directory already answered is never asked about again.
 */
export function useGitBranches(
  directories: readonly string[],
  read: (directory: string) => Promise<{ readonly branch?: string }>,
  /**
   * Anything whose change should make this ask again — in practice, whether
   * the transport is connected. Without it, a mount that happens before the
   * socket is authenticated caches one empty answer and never retries, because
   * the set of directories it watches never changed.
   */
  generation: unknown = true,
): ReadonlyMap<string, string> {
  const [branches, setBranches] = useState<ReadonlyMap<string, string>>(new Map());
  // A stable key so the effect only re-runs when the SET of directories
  // changes, not on every snapshot revision that carries the same ones. The
  // separator is a newline because a Windows path routinely contains spaces.
  const key = [...new Set(directories)].filter(Boolean).sort().join(SEPARATOR);
  const token = String(generation);

  useEffect(() => {
    if (key === '') return undefined;
    let alive = true;
    const wanted = key.split(SEPARATOR);
    void Promise.all(
      wanted.map(async (directory) => {
        const status = await read(directory).catch(() => ({ branch: undefined }));
        return [directory, status.branch] as const;
      }),
    ).then((entries) => {
      if (!alive) return;
      const next = new Map<string, string>();
      for (const [directory, branch] of entries) {
        if (branch) next.set(directory, branch);
      }
      setBranches((previous) => (sameBranches(previous, next) ? previous : next));
    });
    return () => {
      alive = false;
    };
    // `read` is a prop-shaped callback that callers recreate each render;
    // depending on it would poll git forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);

  return branches;
}

/**
 * What Git says about this directory: true, a repository; false, not one, so it can have no worktree; undefined, no answer.
 * A status that failed or timed out rules nothing out: that says nothing about the repository. `generation` as above.
 */
export function useRepositoryAnswer(
  directory: string | undefined,
  read: (directory: string) => Promise<Pick<GitDirectoryStatus, 'availability'>>,
  generation: unknown = true,
): boolean | undefined {
  const [answer, setAnswer] = useState<{ readonly directory: string; readonly repository: boolean } | undefined>(undefined);
  const token = String(generation);

  useEffect(() => {
    if (!directory) return undefined;
    let alive = true;
    void read(directory).then((status) => {
      if (alive) setAnswer(status.availability === 'unavailable' ? undefined : { directory, repository: status.availability === 'ready' });
    }, () => undefined);
    return () => {
      alive = false;
    };
    // As above: `read` is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, token]);

  return directory !== undefined && answer?.directory === directory ? answer.repository : undefined;
}

/** Cannot appear in a filesystem path on any platform this app runs on. */
const SEPARATOR = '\n';

function sameBranches(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
