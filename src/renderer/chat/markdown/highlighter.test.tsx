import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { codeHighlighter, highlightCode, MAX_HIGHLIGHT_LENGTH, resolveCodeLanguage } from './highlighter';

describe('resolveCodeLanguage', () => {
  it('maps fence aliases onto the allow-list', () => {
    expect(resolveCodeLanguage('ts')).toBe('typescript');
    expect(resolveCodeLanguage(' TSX ')).toBe('tsx');
    expect(resolveCodeLanguage('sh')).toBe('shellscript');
    expect(resolveCodeLanguage('bash')).toBe('shellscript');
    expect(resolveCodeLanguage('pwsh')).toBe('powershell');
    expect(resolveCodeLanguage('yml')).toBe('yaml');
    expect(resolveCodeLanguage('c++')).toBe('cpp');
    expect(resolveCodeLanguage('docker')).toBe('dockerfile');
  });

  it('rejects unknown languages and prototype keys', () => {
    for (const language of ['brainfuck', 'text', 'console', '', undefined, '__proto__', 'constructor', 'toString']) {
      expect(resolveCodeLanguage(language), String(language)).toBeUndefined();
    }
  });
});

describe('highlightCode', () => {
  it('returns line content coloured through --ui-code-token-* with semantic fallbacks', async () => {
    const code = 'const answer = 42; // ok\nexport function run() {}';
    const node = await highlightCode(code, 'ts');
    expect(node).not.toBeNull();
    const html = renderToStaticMarkup(<code>{node}</code>);
    expect(html).toContain('var(--ui-code-token-keyword, var(--ui-info))');
    expect(html).toContain('var(--ui-code-token-comment, var(--ui-text-muted))');
    expect(html).not.toMatch(/font-style|font-weight|background/);
    // Highlighting only wraps the text: the rendered characters are unchanged.
    const text = html.replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    expect(text).toBe(code);
    expect(codeHighlighter.peek(code, 'typescript')).toBe(node);
  });

  it('falls back to plain for unknown languages and oversized input', async () => {
    await expect(highlightCode('+[--->++<]>+.', 'brainfuck')).resolves.toBeNull();
    await expect(highlightCode('x'.repeat(MAX_HIGHLIGHT_LENGTH + 1), 'ts')).resolves.toBeNull();
    expect(codeHighlighter.peek('+[--->++<]>+.', 'brainfuck')).toBeUndefined();
  });

  it('loads embedded grammars on demand', async () => {
    const node = await highlightCode('<div class="a"><script>const x = 1;</script></div>', 'html');
    expect(renderToStaticMarkup(<code>{node}</code>)).toContain('--ui-code-token-');
  });
});
