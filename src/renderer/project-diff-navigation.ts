import {
  hasProjectPathControlCharacters,
} from '../shared/project-workspace';

function boundedRelativePath(value: string): string | null {
  if (!value || value.length > 4096 || hasProjectPathControlCharacters(value)) return null;
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    return null;
  }
  return segments.join('/');
}

function normalizedAbsolute(value: string): string {
  const slashed = value.replace(/\\/gu, '/');
  if (slashed === '/' || /^[A-Za-z]:\/$/u.test(slashed)) return slashed;
  return slashed.replace(/\/+$/u, '');
}

/** Converts provider-recorded paths to a project-relative reveal hint.
 * Main still validates the actual review request; this is navigation only. */
export function projectRelativeReviewHint(pathHint: string, rootPath: string): string | null {
  if (!pathHint || !rootPath || pathHint.length > 8192 || rootPath.length > 8192) return null;
  const candidate = normalizedAbsolute(pathHint);
  const root = normalizedAbsolute(rootPath);
  const windowsCandidate = /^[A-Za-z]:\//u.test(candidate) || candidate.startsWith('//');
  const windowsRoot = /^[A-Za-z]:\//u.test(root) || root.startsWith('//');
  const absoluteCandidate = windowsCandidate || candidate.startsWith('/');
  if (!absoluteCandidate) return boundedRelativePath(candidate);
  if (windowsCandidate !== windowsRoot) return null;

  const comparisonCandidate = windowsCandidate ? candidate.toLocaleLowerCase('en-US') : candidate;
  const comparisonRoot = windowsCandidate ? root.toLocaleLowerCase('en-US') : root;
  const prefix = comparisonRoot.endsWith('/') ? comparisonRoot : `${comparisonRoot}/`;
  if (!comparisonCandidate.startsWith(prefix)) return null;
  return boundedRelativePath(candidate.slice(prefix.length));
}
