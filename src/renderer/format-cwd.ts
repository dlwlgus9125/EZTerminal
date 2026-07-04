/**
 * Format a cwd for a terminal-style prompt. Long paths are middle-ellipsized while
 * always preserving the full trailing segment (the directory you are "in"), so the
 * prompt stays readable and the current folder name never gets cut off.
 */
export function formatCwd(cwd: string, max = 44): string {
  if (cwd.length <= max) return cwd;

  // Keep the last path segment intact; ellipsize the prefix in front of it.
  const sep = cwd.includes('\\') ? '\\' : '/';
  const lastSep = cwd.lastIndexOf(sep);
  const tail = lastSep >= 0 ? cwd.slice(lastSep) : cwd; // includes its leading separator
  const head = lastSep >= 0 ? cwd.slice(0, lastSep) : '';

  const keepHead = max - tail.length - 1; // -1 for the ellipsis glyph
  if (keepHead <= 0) return `…${tail}`;
  return `${head.slice(0, keepHead)}…${tail}`;
}
