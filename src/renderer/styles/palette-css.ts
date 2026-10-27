import type { UiThemeColors } from '../../shared/theme-schema';
import { cssColorToRgbChannels, deriveUiTokens, uiThemeColorsToCssVars } from '../theme-contrast';
import { THEME_ORDER, THEMES, type BuiltinPalette } from '../themes';

// The CSS copies of the built-in theme palettes. CSS can't import themes.ts, so
// the foundations carry marked regions whose text is produced here:
//   /* <name>:start — … */ … /* <name>:end */
// ui-tokens.test.ts fails while a region differs from this output and rewrites
// every region with UPDATE_DERIVED_UI_TOKENS=1.

export interface PaletteRegion {
  /** Repository-relative stylesheet. */
  readonly file: string;
  readonly name: string;
  /** Region body, one line each, laid out at its start marker's indentation. */
  readonly lines: readonly string[];
}

function builtin(id: string): { readonly ui: UiThemeColors; readonly palette: BuiltinPalette } {
  return { ui: THEMES[id].ui!, palette: THEMES[id].palette! };
}

/** `{ borderMid }` → `{ '<prefix>border-mid' }`. */
function prefixed(prefix: string, values: object): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    `${prefix}${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
    String(value),
  ]));
}

function rgbChannels(color: string): string {
  const channels = cssColorToRgbChannels(color);
  if (channels === null) throw new Error(`${color} has no RGB channels`);
  return channels;
}

function agentRgbVars({ agentCodex, agentClaude }: BuiltinPalette['chrome']): Record<string, string> {
  return { '--ui-agent-codex-rgb': rgbChannels(agentCodex), '--ui-agent-claude-rgb': rgbChannels(agentClaude) };
}

/** :root semantic fallbacks: the product default (Dark). The other CSS-only
 * chrome roles stay hand-written aliases there, for custom themes. */
function rootUiVars(): Record<string, string> {
  const { ui, palette: { chrome } } = builtin('dark');
  return {
    ...uiThemeColorsToCssVars(ui),
    '--ui-agent-codex': chrome.agentCodex,
    '--ui-agent-claude': chrome.agentClaude,
    ...agentRgbVars(chrome),
  };
}

function themeUiVars(id: string): Record<string, string> {
  const { ui, palette } = builtin(id);
  return {
    ...uiThemeColorsToCssVars(ui),
    ...prefixed('--ui-', palette.chrome),
    ...agentRgbVars(palette.chrome),
    ...prefixed('--ui-code-token-', palette.codeTokens),
  };
}

function derivedUiTokens(id: string): Readonly<Record<string, string>> {
  const { ui, palette } = builtin(id);
  return deriveUiTokens(ui, {
    glow: palette.chrome.glowColor !== 'transparent',
    borderMid: palette.chrome.borderMid,
  });
}

const declarations = (vars: Readonly<Record<string, string>>): string[] =>
  Object.entries(vars).map(([name, value]) => `${name}: ${value};`);

const rule = (selector: string, vars: Readonly<Record<string, string>>): string[] =>
  [`${selector} {`, ...declarations(vars).map((line) => `  ${line}`), '}'];

const INDEX_CSS = 'src/renderer/index.css';
const MOBILE_SHARED_CSS = 'src/renderer/mobile-shared.css';
const UI_TOKENS_CSS = 'src/renderer/styles/ui-tokens.css';

export const PALETTE_REGIONS: readonly PaletteRegion[] = [
  ...[INDEX_CSS, MOBILE_SHARED_CSS].flatMap((file) => THEME_ORDER.map((id) => ({
    file,
    name: `term-palette:${id}`,
    lines: declarations(builtin(id).palette.term),
  }))),
  { file: UI_TOKENS_CSS, name: 'ui-palette:root', lines: declarations(rootUiVars()) },
  ...THEME_ORDER.map((id) => ({ file: UI_TOKENS_CSS, name: `ui-palette:${id}`, lines: declarations(themeUiVars(id)) })),
  {
    file: UI_TOKENS_CSS,
    name: 'derived-ui-tokens',
    lines: [
      ...rule(':root', derivedUiTokens('dark')),
      ...THEME_ORDER.flatMap((id) => rule(`[data-theme='${id}']`, derivedUiTokens(id))),
    ],
  },
];

function locate(source: string, name: string): { start: number; end: number; indent: string } {
  const marker = source.indexOf(`/* ${name}:start`);
  const end = source.indexOf(`/* ${name}:end */`, marker);
  if (marker < 0 || end < 0) throw new Error(`missing /* ${name}:start */ … /* ${name}:end */ markers`);
  const lineStart = source.lastIndexOf('\n', marker) + 1;
  return { start: source.indexOf('*/', marker) + 2, end, indent: source.slice(lineStart, marker) };
}

/** The text between a region's markers as it stands in `source`, with LF line endings. */
export function currentRegion(source: string, region: PaletteRegion): string {
  const { start, end } = locate(source, region.name);
  return source.slice(start, end).replace(/\r\n/gu, '\n');
}

/** The text between a region's markers as generated, with LF line endings. */
export function expectedRegion(source: string, region: PaletteRegion): string {
  const { indent } = locate(source, region.name);
  return `\n${region.lines.map((line) => `${indent}${line}`).join('\n')}\n${indent}`;
}

/** `source` with the region regenerated, keeping the file's line endings. */
export function rewriteRegion(source: string, region: PaletteRegion): string {
  const { start, end } = locate(source, region.name);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source.slice(0, start)}${expectedRegion(source, region).replace(/\n/gu, eol)}${source.slice(end)}`;
}
