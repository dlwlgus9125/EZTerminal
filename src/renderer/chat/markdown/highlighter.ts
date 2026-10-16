import type { Element, ElementContent } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { HighlighterCore, LanguageRegistration } from 'shiki/core';

import type { CodeHighlighter } from './highlight-context';

type LanguageModule = Promise<{ readonly default: LanguageRegistration[] }>;

// Literal import paths so Vite emits one lazy chunk per grammar. `html`,
// `scss`, `xml` and `cpp` pull in the grammars they embed.
const LANGUAGES = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
} satisfies Record<string, () => LanguageModule>;

export type SupportedLanguage = keyof typeof LANGUAGES;

const ALIASES: Readonly<Record<string, SupportedLanguage>> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  sh: 'shellscript', bash: 'shellscript', shell: 'shellscript', zsh: 'shellscript',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  py: 'python', python3: 'python',
  rs: 'rust', golang: 'go',
  h: 'c', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
  htm: 'html', svg: 'xml', md: 'markdown', yml: 'yaml',
  patch: 'diff', docker: 'dockerfile', cfg: 'ini', conf: 'ini',
};

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** Maps a fence info string to an allow-listed grammar; anything else renders plain. */
export function resolveCodeLanguage(language: string | undefined): SupportedLanguage | undefined {
  const key = language?.trim().toLowerCase();
  if (!key) return undefined;
  if (hasOwn(LANGUAGES, key)) return key as SupportedLanguage;
  return hasOwn(ALIASES, key) ? ALIASES[key] : undefined;
}

const THEME = 'ez-chat-code';
// shiki emits `var(--ui-code-token-keyword, var(--ui-info))`: the semantic
// fallback applies until a theme defines `--ui-code-token-*` at any level.
const TOKEN_DEFAULTS: Readonly<Record<string, string>> = {
  foreground: 'var(--ui-text-primary)',
  background: 'var(--ui-chat-code-bg, var(--ui-surface-inset))',
  'token-keyword': 'var(--ui-info)',
  'token-function': 'var(--ui-accent)',
  'token-string': 'var(--ui-success)',
  'token-string-expression': 'var(--ui-success)',
  'token-constant': 'var(--ui-warning)',
  'token-comment': 'var(--ui-text-muted)',
  'token-parameter': 'var(--ui-text-primary)',
  'token-punctuation': 'var(--ui-text-secondary)',
  'token-link': 'var(--ui-chat-link, var(--ui-accent))',
  'token-inserted': 'var(--ui-success)',
  'token-deleted': 'var(--ui-danger)',
  'token-changed': 'var(--ui-warning)',
};

/** Larger blocks stay plain; tokenizing them would stall the renderer. */
export const MAX_HIGHLIGHT_LENGTH = 50_000;
const CACHE_LIMIT = 200;

let core: Promise<HighlighterCore> | undefined;
const languageLoads = new Map<SupportedLanguage, Promise<void>>();
const cache = new Map<string, ReactNode>();

function loadCore(): Promise<HighlighterCore> {
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createCssVariablesTheme, createHighlighterCore }, { createJavaScriptRegexEngine }]) => createHighlighterCore({
      themes: [createCssVariablesTheme({
        name: THEME,
        variablePrefix: '--ui-code-',
        variableDefaults: TOKEN_DEFAULTS,
        // Bold/italic tokens could change glyph advance; colour only keeps the
        // highlighted block exactly as tall and wide as the plain one.
        fontStyle: false,
      })],
      langs: [],
      // The packaged CSP has no 'wasm-unsafe-eval', so Oniguruma WASM is out.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }),
  );
  return core;
}

function loadLanguage(highlighter: HighlighterCore, language: SupportedLanguage): Promise<void> {
  let pending = languageLoads.get(language);
  if (!pending) {
    pending = LANGUAGES[language]().then((module) => highlighter.loadLanguage(module.default));
    languageLoads.set(language, pending);
  }
  return pending;
}

function remember(key: string, node: ReactNode): void {
  cache.delete(key);
  cache.set(key, node);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function codeChildren(root: { readonly children: readonly unknown[] }): ElementContent[] {
  const pre = root.children[0] as Element | undefined;
  const code = pre?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  return code?.children ?? [];
}

export async function highlightCode(code: string, language: string): Promise<ReactNode | null> {
  const resolved = resolveCodeLanguage(language);
  if (!resolved || code.length > MAX_HIGHLIGHT_LENGTH) return null;
  const key = `${resolved}\u0000${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const highlighter = await loadCore();
    await loadLanguage(highlighter, resolved);
    const root = highlighter.codeToHast(code, { lang: resolved, theme: THEME });
    const node = toJsxRuntime({ type: 'root', children: codeChildren(root) }, { Fragment, jsx, jsxs });
    remember(key, node);
    return node;
  } catch {
    return null;
  }
}

export const codeHighlighter: CodeHighlighter = {
  peek: (code, language) => {
    const resolved = resolveCodeLanguage(language);
    return resolved ? cache.get(`${resolved}\u0000${code}`) : undefined;
  },
  highlight: highlightCode,
};
