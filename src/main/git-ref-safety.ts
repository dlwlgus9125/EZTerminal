/**
 * Checks for a branch name a client hands to a host Git read (Project review's branch scope, the
 * review loop's base branch). Only a plain local branch name is accepted: no option, range or
 * revision syntax, resolved under `refs/heads` and checked by Git itself before use.
 */

/** A name that cannot be read as an option, a range or a revision expression. */
export function isSafeRef(value: string): boolean {
  return value.length > 0
    && value.length <= 200
    && !value.startsWith('-')
    && !value.includes('\0')
    && !value.includes('..')
    && /^[A-Za-z0-9_./-]+$/u.test(value);
}

/** Runs one Git command in the repository (callers add their own safe prefix and filters). */
export type GitRefRun = (args: readonly string[]) => Promise<string>;

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function objectId(output: string, what: string): string {
  const value = output.trim();
  if (!OBJECT_ID.test(value)) throw new Error(`Git returned no commit for ${what}.`);
  return value;
}

/**
 * `refs/heads/<baseRef>`'s commit and where `head` left it (their merge base). Throws when the
 * name is unsafe, Git rejects it, the branch does not exist or the two share no history.
 */
export async function resolveMergeBase(
  run: GitRefRun,
  baseRef: string,
  head: string,
): Promise<{ readonly base: string; readonly mergeBase: string }> {
  if (!isSafeRef(baseRef)) throw new Error('The base branch name is not a plain branch name.');
  await run(['check-ref-format', `refs/heads/${baseRef}`]);
  const base = objectId(await run(['rev-parse', '--verify', `refs/heads/${baseRef}^{commit}`]), baseRef);
  const mergeBase = objectId(await run(['merge-base', base, head]), `${baseRef}...HEAD`);
  return { base, mergeBase };
}
