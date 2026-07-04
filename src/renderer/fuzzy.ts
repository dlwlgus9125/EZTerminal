/**
 * Case-insensitive subsequence match: every character of `query`, in order,
 * appears somewhere in `text` (not necessarily contiguously). Used by the
 * command palette to filter actions as the user types — e.g. "spr" matches
 * "Split right". An empty query matches everything.
 */
export function subsequenceMatch(text: string, query: string): boolean {
  if (query.length === 0) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return false;
    ti += 1;
  }
  return true;
}
