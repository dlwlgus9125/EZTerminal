/**
 * Writable path scopes of a planned or workflow task ("src/ui", "src/**", "."), read the same way
 * everywhere: by preparation and stage binding (do two tasks that may run together write the same
 * files?) and by result capture (may this task change this file?).
 */

/** The directory a scope covers, normalised ("src/**" and "src/" are "src"; "." is the whole tree); null when it is not a valid scope. */
export function writeScopeRoot(scope: string): string | null {
  const root = scope.replaceAll('\\', '/').replace(/\/+$/u, '').replace(/\/\*\*$/u, '');
  if (!root || root.includes('*') || root.startsWith('/') || /^[A-Za-z]:/u.test(root) || root.split('/').includes('..')) return null;
  return root;
}

/** True when some scope of one list covers some file of the other (case-insensitive, so it errs towards overlap). */
export function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const roots = (scopes: readonly string[]) => scopes.map(writeScopeRoot).filter((root): root is string => root !== null).map((root) => root.toLowerCase());
  const a = roots(left); const b = roots(right);
  return a.some((first) => b.some((second) => first === '.' || second === '.' || first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`)));
}
