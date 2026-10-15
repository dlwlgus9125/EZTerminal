import type { Element, ElementContent } from 'hast';
import { memo, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { classNames } from '../../ui/utils';
import { CodeBlock, type CodeBlockLabels } from './CodeBlock';
import {
  isFileReference,
  normalizeChatLinkHref,
  type FileLinkTarget,
  type ResolveFileLink,
} from './file-links';
import { DeferHighlightContext } from './highlight-context';
import { FILE_REFERENCE_TAG, rehypeFileReferences, rehypeStreamFade } from './rehype-chat';
import { splitMarkdownBlocks, type MarkdownBlock } from './split-blocks';
import './markdown.css';

export interface ChatMarkdownLabels extends CodeBlockLabels {
  readonly blockedImage: (label: string) => string;
  readonly task: string;
}

export const DEFAULT_CHAT_MARKDOWN_LABELS: ChatMarkdownLabels = {
  copyCode: 'Copy code',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  wrapLines: 'Wrap lines',
  blockedImage: (label) => `Image not loaded: ${label}`,
  task: 'Task',
};

export interface ChatMarkdownProps {
  readonly markdown: string;
  /** The reply is still arriving: only the last block re-parses and new words fade in. */
  readonly streaming?: boolean;
  /** Receives normalized http(s) and mailto URLs; the window never navigates. */
  readonly onOpenLink?: (href: string) => void;
  /** Keep this stable (memoized): settled blocks re-render when it changes. */
  readonly resolveFileLink?: ResolveFileLink;
  readonly onOpenFile?: (file: FileLinkTarget) => void;
  readonly className?: string;
  readonly variant?: 'prose' | 'cli';
  /** Localized strings; keep the object stable. Defaults are English. */
  readonly labels?: Partial<ChatMarkdownLabels>;
}

type PluggableList = NonNullable<Options['rehypePlugins']>;

// `~` alone is too common in chat ("~5 min") to mean strikethrough.
const REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]];
const SETTLED_REHYPE_PLUGINS: PluggableList = [rehypeFileReferences];

interface Handlers {
  readonly onOpenLink?: (href: string) => void;
  readonly onOpenFile?: (file: FileLinkTarget) => void;
}

function textContent(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map(textContent).join('') : '';
}

function codeFromPre(node: Element | undefined): { readonly code: string; readonly language?: string } {
  const code = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  if (!code) return { code: '' };
  const classes = code.properties.className;
  const language = Array.isArray(classes)
    ? classes.map(String).find((name) => name.startsWith('language-'))?.slice('language-'.length)
    : undefined;
  // mdast-util-to-hast appends one newline to every fenced block.
  const text = textContent(code).replace(/\n$/, '');
  return language ? { code: text, language } : { code: text };
}

function safeDecode(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function FileLink({ target, onOpen, children }: {
  readonly target: FileLinkTarget;
  readonly onOpen: (target: FileLinkTarget) => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="chat-md__file-link"
      title={target.line === undefined ? target.path : `${target.path}:${target.line}`}
      onClick={() => onOpen(target)}
    >
      {children}
    </button>
  );
}

function createComponents(
  handlers: MutableRefObject<Handlers>,
  linksActive: boolean,
  resolveFile: ResolveFileLink | undefined,
  labels: ChatMarkdownLabels,
): Components {
  const openFile = (target: FileLinkTarget): void => handlers.current.onOpenFile?.(target);
  const fileLink = (text: string, children: ReactNode): ReactNode => {
    const target = resolveFile?.(text);
    return target ? <FileLink target={target} onOpen={openFile}>{children}</FileLink> : children;
  };

  const components: Components & Record<typeof FILE_REFERENCE_TAG, Components['span']> = {
    a: ({ href, children }) => {
      const safe = normalizeChatLinkHref(href);
      if (!safe) return <span>{href ? fileLink(safeDecode(href), children) : children}</span>;
      if (!linksActive) {
        return <span className="chat-md__link" role="link" aria-disabled="true" title={safe}>{children}</span>;
      }
      return (
        <a
          className="chat-md__link"
          href={safe}
          title={safe}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            handlers.current.onOpenLink?.(safe);
          }}
          onAuxClick={(event) => event.preventDefault()}
        >
          {children}
        </a>
      );
    },
    img: ({ alt, src }) => (
      <span className="chat-md__blocked-image">{labels.blockedImage(alt || (typeof src === 'string' ? src : '') || '—')}</span>
    ),
    // Fenced blocks never reach the `code` override: `pre` renders them whole.
    pre: ({ node }) => {
      const { code, language } = codeFromPre(node);
      return <CodeBlock code={code} language={language} labels={labels} />;
    },
    code: ({ children }) => {
      const element = <code className="chat-md__inline-code">{children}</code>;
      return typeof children === 'string' && isFileReference(children) ? fileLink(children, element) : element;
    },
    table: ({ children }) => (
      // Focusable so a wide table can be scrolled from the keyboard.
      <div className="chat-md__table" tabIndex={0}>
        <table>{children}</table>
      </div>
    ),
    input: ({ type, checked }) => (type === 'checkbox'
      ? <input className="chat-md__task" type="checkbox" checked={Boolean(checked)} disabled aria-label={labels.task} />
      : null),
    [FILE_REFERENCE_TAG]: ({ node, children }) => {
      const reference = node?.properties.dataReference;
      return <>{typeof reference === 'string' ? fileLink(reference, children) : children}</>;
    },
  };
  return components;
}

/** Offset where a delta's new words begin; a delta that only finishes a word adds none. */
function revealOffset(text: string, from: number): number | undefined {
  if (from === 0 || /\s/.test(text[from - 1]!) || /\s/.test(text[from]!)) return from;
  const space = text.slice(from).search(/\s/);
  return space === -1 ? undefined : from + space;
}

/**
 * Remembers where each streamed delta started and maps those marks onto the
 * blocks they touched. Marks only accumulate while streaming and are kept
 * after it ends, so already-faded spans stay mounted rather than re-render.
 */
function useRevealSegments(
  markdown: string,
  streaming: boolean,
  blocks: readonly MarkdownBlock[],
): readonly (readonly number[] | undefined)[] {
  const state = useRef({ markdown, marks: [] as number[] }).current;
  if (state.markdown !== markdown) {
    if (streaming && markdown.length > state.markdown.length && markdown.startsWith(state.markdown)) {
      const mark = revealOffset(markdown, state.markdown.length);
      if (mark !== undefined) state.marks.push(mark);
    } else {
      state.marks = [];
    }
    state.markdown = markdown;
  }

  const { marks } = state;
  return blocks.map((block) => {
    if (marks.length === 0) return undefined;
    const end = block.start + block.text.length;
    const local: number[] = [];
    let revealedBefore = false;
    for (const mark of marks) {
      if (mark < block.start) revealedBefore = true;
      else if (mark < end) local.push(mark - block.start);
    }
    // A delta that began in an earlier block also revealed this block's start.
    if (revealedBefore && local[0] !== 0) local.unshift(0);
    return local.length > 0 ? local : undefined;
  });
}

function sameSegments(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

interface BlockProps {
  readonly text: string;
  readonly components: Components;
  readonly segments: readonly number[] | undefined;
  readonly deferHighlight: boolean;
}

const Block = memo(function Block({ text, components, segments, deferHighlight }: BlockProps): JSX.Element {
  const rehypePlugins = useMemo<PluggableList>(
    () => (segments ? [[rehypeStreamFade, { segments }], rehypeFileReferences] : SETTLED_REHYPE_PLUGINS),
    [segments],
  );
  return (
    <DeferHighlightContext.Provider value={deferHighlight}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </DeferHighlightContext.Provider>
  );
}, (previous, next) => previous.text === next.text
  && previous.components === next.components
  && previous.deferHighlight === next.deferHighlight
  && sameSegments(previous.segments, next.segments));

/**
 * Assistant prose for the agent chat: GFM without raw HTML or remote media,
 * links routed through `onOpenLink`, path-shaped text linked through
 * `resolveFileLink`, and fenced code in `CodeBlock`. The message is split into
 * top-level blocks so a streamed reply re-parses only its last block.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  className,
  labels,
  markdown,
  onOpenFile,
  onOpenLink,
  resolveFileLink,
  streaming = false,
  variant = 'prose',
}: ChatMarkdownProps): JSX.Element {
  const handlers = useRef<Handlers>({});
  handlers.current = { onOpenLink, onOpenFile };

  const blocks = useMemo(() => splitMarkdownBlocks(markdown), [markdown]);
  const segments = useRevealSegments(markdown, streaming, blocks);
  const resolvedLabels = useMemo(() => ({ ...DEFAULT_CHAT_MARKDOWN_LABELS, ...labels }), [labels]);
  const linksActive = Boolean(onOpenLink);
  const resolveFile = onOpenFile ? resolveFileLink : undefined;
  const components = useMemo(
    () => createComponents(handlers, linksActive, resolveFile, resolvedLabels),
    [linksActive, resolveFile, resolvedLabels],
  );

  return (
    <div className={classNames('chat-md', className)} data-variant={variant}>
      {blocks.map((block, index) => (
        <Block
          // Index keys: a block's text changes while it streams, and repeated
          // blocks would collide as keys.
          key={index}
          text={block.text}
          components={components}
          segments={segments[index]}
          deferHighlight={streaming && index === blocks.length - 1}
        />
      ))}
    </div>
  );
});
