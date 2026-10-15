export interface MarkdownBlock {
  /** Source of one top-level block, without the blank lines that separate it. */
  readonly text: string;
  /** Offset of `text` inside the full message. */
  readonly start: number;
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const BLANK = /^\s*$/;
const INDENTED = /^\s/;
const COMMENT_OPEN = /^ {0,3}<!--/;
// Reference definitions and footnotes resolve across the whole document, so a
// message that uses them is parsed as one block.
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

interface OpenFence {
  readonly marker: string;
  readonly length: number;
}

function fenceOpening(line: string): OpenFence | undefined {
  const match = line.match(FENCE);
  if (!match) return undefined;
  const marker = match[1]!;
  // ```inline``` on one line is a code span, not a fence.
  if (marker[0] === '`' && match[2]!.includes('`')) return undefined;
  return { marker: marker[0]!, length: marker.length };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = line.match(FENCE);
  return Boolean(
    match
    && match[1]![0] === fence.marker
    && match[1]!.length >= fence.length
    && BLANK.test(match[2]!),
  );
}

/**
 * Splits a message at blank lines that end a top-level block, so a streamed
 * reply re-parses only its tail. A blank line is NOT a split point inside a
 * fence or HTML comment, before an indented line (list continuation, nested
 * list, indented code), or between items of the same loose list. An unclosed
 * fence keeps everything after it in the last block, which CommonMark renders
 * as a code block running to the end.
 */
export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  if (DEFINITION.test(markdown)) return [{ text: markdown, start: 0 }];

  const lines: { readonly text: string; readonly start: number }[] = [];
  for (let cursor = 0; ;) {
    const end = markdown.indexOf('\n', cursor);
    lines.push({ text: markdown.slice(cursor, end === -1 ? markdown.length : end), start: cursor });
    if (end === -1) break;
    cursor = end + 1;
  }

  const blocks: MarkdownBlock[] = [];
  let blockStart = 0;
  let blockEnd = 0;
  let fence: OpenFence | undefined;
  let inComment = false;
  let lastUnindented = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence || inComment) {
      if (fence && closesFence(line.text, fence)) fence = undefined;
      if (inComment && line.text.includes('-->')) inComment = false;
      blockEnd = line.start + line.text.length;
      continue;
    }
    if (!BLANK.test(line.text)) {
      fence = fenceOpening(line.text);
      if (!fence && COMMENT_OPEN.test(line.text) && !line.text.includes('-->')) inComment = true;
      if (!INDENTED.test(line.text)) lastUnindented = line.text;
      blockEnd = line.start + line.text.length;
      continue;
    }

    let next = index + 1;
    while (next < lines.length && BLANK.test(lines[next]!.text)) next += 1;
    if (next >= lines.length) break;
    const following = lines[next]!.text;
    if (INDENTED.test(following)) continue;
    if (LIST_ITEM.test(following) && LIST_ITEM.test(lastUnindented)) continue;

    if (blockEnd > blockStart) blocks.push({ text: markdown.slice(blockStart, blockEnd), start: blockStart });
    blockStart = lines[next]!.start;
    blockEnd = blockStart;
    lastUnindented = '';
    index = next - 1;
  }

  // An open fence owns everything to the end, trailing blank lines included.
  const tailEnd = fence || inComment ? markdown.length : blockEnd;
  if (tailEnd > blockStart) blocks.push({ text: markdown.slice(blockStart, tailEnd), start: blockStart });
  return blocks;
}
