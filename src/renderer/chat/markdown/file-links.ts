import { normalizeExternalHttpUrl } from '../../../shared/external-url';

export interface FileLinkTarget {
  readonly path: string;
  readonly line?: number;
}

export type ResolveFileLink = (text: string) => FileLinkTarget | undefined;

/**
 * A path-shaped token: optional drive, `./`, `../`, `~/` or root prefix,
 * directory segments, then either a file name with an extension or at least
 * one separator, and an optional `:line` or `:line:column`. Extensions start
 * with a letter so version numbers such as `1.2.3` never qualify. Whether the
 * file exists is the resolver's decision.
 */
const PATH_SOURCE = String.raw`(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?`
  + String.raw`(?:(?:[\w@.-]+[\\/])+[\w@.-]*[\w@-]|(?:[\w@-][\w@.-]*)?\.[A-Za-z][\w-]{0,15})`
  + String.raw`(?::\d+(?::\d+)?)?`;

const WHOLE_FILE_REFERENCE = new RegExp(`^${PATH_SOURCE}$`);
const FILE_REFERENCE_IN_TEXT = new RegExp(
  // Korean particles attach directly to the path (`README.md를`), so any
  // non-ASCII character also ends a reference.
  String.raw`(?<=^|[\s([{"'‘“])${PATH_SOURCE}(?=$|[\s)\]}"'’”,;!?\u0080-￿]|[.:](?:\s|$))`,
  'g',
);
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

/** True when the whole string (e.g. an inline code span) looks like a path. */
export function isFileReference(text: string): boolean {
  return text.length <= 512 && WHOLE_FILE_REFERENCE.test(text);
}

/** Path-shaped tokens inside running prose, with their offsets. */
export function findFileReferences(text: string): { readonly text: string; readonly index: number }[] {
  const found: { text: string; index: number }[] = [];
  for (const match of text.matchAll(FILE_REFERENCE_IN_TEXT)) {
    found.push({ text: match[0], index: match.index ?? 0 });
  }
  return found;
}

/** Splits `src/app.ts:42` into a path and line; a building block for resolvers. */
export function parseFileReference(text: string): FileLinkTarget | undefined {
  if (!isFileReference(text)) return undefined;
  const suffix = text.match(LINE_SUFFIX);
  if (!suffix) return { path: text };
  return { path: text.slice(0, suffix.index), line: Number(suffix[1]) };
}

/** Only http(s) and mailto open externally; every other scheme renders as text. */
export function normalizeChatLinkHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const http = normalizeExternalHttpUrl(href);
  if (http) return http;
  if (!/^mailto:/i.test(href)) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'mailto:' && url.pathname.length > 0 ? url.href : undefined;
  } catch {
    return undefined;
  }
}
