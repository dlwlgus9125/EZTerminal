import type { Element, ElementContent, Root, RootContent, Text } from 'hast';

import { findFileReferences } from './file-links';

/** hast tag the `ChatMarkdown` components map renders as a file link or text. */
export const FILE_REFERENCE_TAG = 'ez-file-ref';
export const FADE_CLASS = 'chat-md__fade';

type Parent = Root | Element;

const CODE_TAGS: ReadonlySet<string> = new Set(['pre', 'code']);
const NON_REFERENCE_TAGS: ReadonlySet<string> = new Set(['pre', 'code', 'a', FILE_REFERENCE_TAG]);

function mapText(parent: Parent, skip: ReadonlySet<string>, replace: (text: Text) => ElementContent[]): void {
  const next: RootContent[] = [];
  for (const child of parent.children) {
    if (child.type === 'text') {
      next.push(...replace(child));
    } else {
      if (child.type === 'element' && !skip.has(child.tagName)) mapText(child, skip, replace);
      next.push(child);
    }
  }
  parent.children = next as Parent['children'];
}

/** Marks path-shaped prose tokens; the component decides whether they resolve. */
export function rehypeFileReferences() {
  return (tree: Root): void => {
    mapText(tree, NON_REFERENCE_TAGS, (node) => {
      const found = findFileReferences(node.value);
      if (found.length === 0) return [node];
      const pieces: ElementContent[] = [];
      let cursor = 0;
      for (const reference of found) {
        if (reference.index > cursor) {
          pieces.push({ type: 'text', value: node.value.slice(cursor, reference.index) });
        }
        pieces.push({
          type: 'element',
          tagName: FILE_REFERENCE_TAG,
          properties: { dataReference: reference.text },
          children: [{ type: 'text', value: reference.text }],
        });
        cursor = reference.index + reference.text.length;
      }
      if (cursor < node.value.length) pieces.push({ type: 'text', value: node.value.slice(cursor) });
      return pieces;
    });
  };
}

function fadeSpan(value: string): Element {
  return { type: 'element', tagName: 'span', properties: { className: [FADE_CLASS] }, children: [{ type: 'text', value }] };
}

export interface StreamFadeOptions {
  /** Block-local source offsets where each newly revealed run of words starts. */
  readonly segments: readonly number[];
}

/**
 * Wraps text revealed after `segments[0]` in one span per segment. Spans are
 * appended in source order, so React keeps the spans it already mounted and
 * only a newly mounted span runs its opacity animation. Text whose source
 * length differs from its rendered value (escapes, list indentation) is
 * treated as a whole by where it starts.
 */
export function rehypeStreamFade({ segments }: StreamFadeOptions) {
  return (tree: Root): void => {
    const first = segments[0];
    if (first === undefined) return;
    mapText(tree, CODE_TAGS, (node) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || end <= first || !/\S/.test(node.value)) return [node];
      if (end - start !== node.value.length) return start >= first ? [fadeSpan(node.value)] : [node];

      const pieces: ElementContent[] = [];
      let cursor = start;
      const cuts = segments.filter((offset) => offset > start && offset < end);
      for (const cut of [...cuts, end]) {
        const value = node.value.slice(cursor - start, cut - start);
        pieces.push(cursor >= first ? fadeSpan(value) : { type: 'text', value });
        cursor = cut;
      }
      return pieces;
    });
  };
}
