// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatMarkdown, type ChatMarkdownProps } from './ChatMarkdown';
import { parseFileReference } from './file-links';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(props: ChatMarkdownProps): HTMLDivElement {
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<ChatMarkdown {...props} />));
  return host;
}

const KNOWN_FILES = new Set(['src/app.ts', 'README.md']);
const resolveFileLink = (text: string) => {
  const target = parseFileReference(text);
  return target && KNOWN_FILES.has(target.path) ? target : undefined;
};

describe('ChatMarkdown links', () => {
  it('routes http(s) and mailto links through onOpenLink without navigating', () => {
    const onOpenLink = vi.fn();
    const view = render({
      markdown: '[docs](https://example.com/docs) <https://example.org> [mail](mailto:dev@example.com)',
      onOpenLink,
    });
    const anchors = [...view.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      'https://example.com/docs',
      'https://example.org/',
      'mailto:dev@example.com',
    ]);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { anchors[0]!.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('keeps links inert but announced as unavailable without a handler', () => {
    const view = render({ markdown: '[docs](https://example.com/docs)' });
    expect(view.querySelector('a')).toBeNull();
    const link = view.querySelector('[role="link"]')!;
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('title')).toBe('https://example.com/docs');
    expect(link.textContent).toBe('docs');
  });

  it('renders other schemes as plain text and blocks images', () => {
    const view = render({
      markdown: '[run](javascript:alert(1)) [file](file:///C:/x) ![diagram](https://example.com/a.png)',
      onOpenLink: vi.fn(),
    });
    expect(view.querySelector('a, [role="link"]')).toBeNull();
    expect(view.textContent).toContain('run');
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('.chat-md__blocked-image')!.textContent).toBe('Image not loaded: diagram');
  });

  it('never renders raw HTML', () => {
    const view = render({ markdown: 'a <b onclick="x()">bold</b>\n\n<script>alert(1)</script>' });
    expect(view.querySelector('b, script')).toBeNull();
  });
});

describe('ChatMarkdown file references', () => {
  it('links resolvable inline code, prose paths and relative markdown links', () => {
    const onOpenFile = vi.fn();
    const view = render({
      markdown: 'Edit `src/app.ts:42`, read README.md. Skip `src/missing.ts` and [the app](src/app.ts:7).',
      resolveFileLink,
      onOpenFile,
    });
    const buttons = [...view.querySelectorAll<HTMLButtonElement>('button.chat-md__file-link')];
    expect(buttons.map((button) => button.textContent)).toEqual(['src/app.ts:42', 'README.md', 'the app']);
    expect(buttons[0]!.querySelector('code')).not.toBeNull();
    act(() => buttons[0]!.click());
    act(() => buttons[2]!.click());
    expect(onOpenFile.mock.calls).toEqual([[{ path: 'src/app.ts', line: 42 }], [{ path: 'src/app.ts', line: 7 }]]);
    expect(view.textContent).toContain('src/missing.ts');
  });

  it('does not link files when nothing can open them', () => {
    const view = render({ markdown: 'Edit `src/app.ts` and README.md', resolveFileLink });
    expect(view.querySelector('button')).toBeNull();
    expect(view.textContent).toBe('Edit src/app.ts and README.md');
  });
});

describe('ChatMarkdown rendering', () => {
  it('renders a long reply in the first commit without a pending placeholder', () => {
    const paragraph = 'This sentence is part of a long assistant reply that must render at once. ';
    const markdown = Array.from({ length: 12 }, (_, index) => `## Part ${index}\n\n${paragraph.repeat(7)}`).join('\n\n');
    expect(markdown.length).toBeGreaterThan(6_000);
    const view = render({ markdown });
    expect(view.querySelectorAll('h2')).toHaveLength(12);
    expect(view.querySelector('[data-markdown-pending]')).toBeNull();
    expect(view.textContent).toContain('Part 11');
  });

  it('renders code blocks plain without a highlighter, with or without a language', () => {
    const view = render({ markdown: '```brainfuck\n+[-]\n```\n\n```\nplain\n```' });
    const blocks = view.querySelectorAll('.chat-md-code');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.querySelector('.chat-md-code__language')!.textContent).toBe('brainfuck');
    expect(blocks[0]!.querySelector('code')!.textContent).toBe('+[-]');
    expect(blocks[1]!.classList.contains('chat-md-code--bare')).toBe(true);
    expect(blocks[1]!.querySelector('.chat-md-code__header')).toBeNull();
    expect(blocks[1]!.querySelector('code')!.textContent).toBe('plain');
  });

  it('renders GFM tables, task lists and strikethrough but not single tildes', () => {
    const view = render({ markdown: '| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n~~gone~~ ~5 min ~ok' });
    expect(view.querySelector('.chat-md__table table')).not.toBeNull();
    const boxes = [...view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([[true, true], [false, true]]);
    expect(view.querySelectorAll('del')).toHaveLength(1);
    expect(view.textContent).toContain('~5 min ~ok');
  });
});

describe('ChatMarkdown streaming', () => {
  it('re-renders only the tail and fades only newly revealed words', () => {
    const first = 'Settled paragraph.\n\nThe tail';
    const view = render({ markdown: first, streaming: true });
    const settled = view.querySelector('p')!;
    expect(view.querySelector('.chat-md__fade')).toBeNull();

    render({ markdown: `${first} keeps growing`, streaming: true });
    expect(view.querySelector('p')).toBe(settled);
    expect([...view.querySelectorAll('.chat-md__fade')].map((span) => span.textContent)).toEqual([' keeps growing']);

    render({ markdown: `${first} keeps growing and grows`, streaming: true });
    const fades = [...view.querySelectorAll('.chat-md__fade')];
    expect(fades.map((span) => span.textContent)).toEqual([' keeps growing', ' and grows']);
    expect(view.querySelectorAll('p')[1]!.textContent).toBe('The tail keeps growing and grows');
  });

  it('continues a split word in the span that already shows it', () => {
    const view = render({ markdown: 'Hel', streaming: true });
    render({ markdown: 'Hello wor', streaming: true });
    render({ markdown: 'Hello world', streaming: true });
    expect([...view.querySelectorAll('.chat-md__fade')].map((span) => span.textContent)).toEqual([' world']);
    expect(view.textContent).toBe('Hello world');
  });

  it('renders a half-open fence as a code block while streaming', () => {
    const view = render({ markdown: 'Run this:\n\n```bash\nnpm ci\n\nnpm test', streaming: true });
    const code = view.querySelector('.chat-md-code code')!;
    expect(code.textContent).toBe('npm ci\n\nnpm test');
    expect(view.querySelector('.chat-md-code__language')!.textContent).toBe('bash');
    expect(code.querySelector('.chat-md__fade')).toBeNull();
  });
});
