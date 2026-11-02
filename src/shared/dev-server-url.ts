import { siteClass } from './browser';

/**
 * The local addresses a terminal or an AI's output names, offered in the empty pane and to the AI. Nothing here opens
 * anything, and a port is only ever a candidate.
 */

// eslint-disable-next-line no-control-regex -- terminal escape sequences are control characters.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
const URLS = /\bhttps?:\/\/[^\s"'<>`]+/giu;
/** What ends a sentence or closes a bracket around an address, and is no part of it. */
const TRAILING = /[.,;:!?)\]}]+$/u;

export function findDevUrls(text: string, controlPorts?: ReadonlySet<number>): readonly string[] {
  const found = new Set<string>();
  for (const match of text.replace(ANSI, '').matchAll(URLS)) {
    const written = match[0].replace(TRAILING, '').replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/iu, '$1localhost');
    if (!URL.canParse(written)) continue;
    const url = new URL(written).href;
    if (siteClass(url, [], controlPorts ? { controlPorts } : {}) === 'local') found.add(url);
  }
  return [...found];
}

const TAIL_CHARS = 512;
const REMEMBERED = 200;

/** One terminal's output, a chunk at a time. An address counts when its line is done: a chunk can end in the middle of a port. */
export class DevUrlScanner {
  private readonly decoder = new TextDecoder();
  private tail = '';
  private readonly seen = new Set<string>();

  feed(bytes: Uint8Array): readonly string[] {
    const text = this.tail + this.decoder.decode(bytes, { stream: true });
    const lineEnd = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    this.tail = text.slice(lineEnd + 1).slice(-TAIL_CHARS);
    if (lineEnd < 0) return [];
    const done = text.slice(Math.max(0, lineEnd - 64 * 1024), lineEnd);
    if (!done.includes('://')) return [];
    const fresh = findDevUrls(done).filter((url) => !this.seen.has(url));
    for (const url of fresh) {
      this.seen.add(url);
      if (this.seen.size > REMEMBERED) this.seen.delete(this.seen.values().next().value!);
    }
    return fresh;
  }
}
