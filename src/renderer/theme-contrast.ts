import type { UiThemeColors } from '../shared/theme-schema';
import type { ThemeAdjustment, ThemeDefinition } from './themes';

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const BASIC_NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  rebeccapurple: '#663399',
  transparent: '#00000000',
};

const UI_CSS_VAR_NAMES: Readonly<Record<keyof UiThemeColors, string>> = {
  canvas: '--ui-canvas',
  surface: '--ui-surface',
  surfaceRaised: '--ui-surface-raised',
  surfaceInset: '--ui-surface-inset',
  textPrimary: '--ui-text-primary',
  textSecondary: '--ui-text-secondary',
  textMuted: '--ui-text-muted',
  textInverse: '--ui-text-inverse',
  borderSubtle: '--ui-border-subtle',
  borderStrong: '--ui-border-strong',
  accent: '--ui-accent',
  onAccent: '--ui-on-accent',
  focus: '--ui-focus',
  info: '--ui-info',
  success: '--ui-success',
  warning: '--ui-warning',
  danger: '--ui-danger',
};

function clamp(value: number, min = 0, max = 255): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(value: string): RgbaColor | null {
  const hex = value.slice(1);
  if (![3, 4, 6, 8].includes(hex.length)) return null;
  const expanded = hex.length <= 4 ? [...hex].map((part) => `${part}${part}`).join('') : hex;
  const hasAlpha = expanded.length === 8;
  const number = Number.parseInt(expanded, 16);
  if (!Number.isFinite(number)) return null;
  return {
    r: hasAlpha ? (number >>> 24) & 0xff : (number >>> 16) & 0xff,
    g: hasAlpha ? (number >>> 16) & 0xff : (number >>> 8) & 0xff,
    b: hasAlpha ? (number >>> 8) & 0xff : number & 0xff,
    a: hasAlpha ? (number & 0xff) / 255 : 1,
  };
}

function parseRgbChannel(value: string): number | null {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return value.endsWith('%') ? clamp((parsed / 100) * 255) : clamp(parsed);
}

function parseAlpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 1;
  return clamp(value.endsWith('%') ? parsed / 100 : parsed, 0, 1);
}

function functionalParts(value: string): string[] {
  return value
    .slice(value.indexOf('(') + 1, -1)
    .replace(/,/g, ' ')
    .replace(/\//g, ' / ')
    .trim()
    .split(/\s+/);
}

function parseRgb(value: string): RgbaColor | null {
  const parts = functionalParts(value);
  const slash = parts.indexOf('/');
  const channels = slash >= 0 ? parts.slice(0, slash) : parts.slice(0, 3);
  const alpha = slash >= 0 ? parts[slash + 1] : parts[3];
  if (channels.length !== 3) return null;
  const [r, g, b] = channels.map(parseRgbChannel);
  if (r === null || g === null || b === null) return null;
  return { r, g, b, a: parseAlpha(alpha) };
}

function hueToRgb(p: number, q: number, rawT: number): number {
  let t = rawT;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function parseHue(value: string): number | null {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (value.endsWith('turn')) return parsed * 360;
  if (value.endsWith('grad')) return parsed * 0.9;
  if (value.endsWith('rad')) return (parsed * 180) / Math.PI;
  return parsed;
}

function parseHsl(value: string): RgbaColor | null {
  const parts = functionalParts(value);
  const slash = parts.indexOf('/');
  const channels = slash >= 0 ? parts.slice(0, slash) : parts.slice(0, 3);
  const alpha = slash >= 0 ? parts[slash + 1] : parts[3];
  if (channels.length !== 3 || !channels[1].endsWith('%') || !channels[2].endsWith('%')) return null;
  const hue = parseHue(channels[0]);
  const saturation = Number.parseFloat(channels[1]) / 100;
  const lightness = Number.parseFloat(channels[2]) / 100;
  if (hue === null || !Number.isFinite(saturation) || !Number.isFinite(lightness)) return null;
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  if (s === 0) {
    const gray = l * 255;
    return { r: gray, g: gray, b: gray, a: parseAlpha(alpha) };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255,
    a: parseAlpha(alpha),
  };
}

function browserNormalizedColor(value: string): string | null {
  if (typeof document === 'undefined' || document.body === null) return null;
  const probe = document.createElement('span');
  probe.style.color = '';
  probe.style.color = value;
  if (probe.style.color === '') return null;
  probe.hidden = true;
  document.body.appendChild(probe);
  const normalized = getComputedStyle(probe).color;
  probe.remove();
  return normalized && normalized.toLowerCase() !== value.toLowerCase() ? normalized : null;
}

/** Parse the color formats accepted by ThemeModSchema. Browser normalization
 * covers the full CSS named-color set; the pure parser keeps tests and SSR-like
 * tooling deterministic for hex/rgb/hsl and common names. */
export function parseCssColor(rawValue: string): RgbaColor | null {
  const value = rawValue.trim().toLowerCase();
  if (value.startsWith('#')) return parseHex(value);
  if (/^rgba?\(/.test(value)) return parseRgb(value);
  if (/^hsla?\(/.test(value)) return parseHsl(value);
  const named = BASIC_NAMED_COLORS[value];
  if (named) return parseHex(named);
  const normalized = browserNormalizedColor(value);
  return normalized ? parseCssColor(normalized) : null;
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function opaque(color: RgbaColor): RgbaColor {
  return composite(color, { r: 0, g: 0, b: 0, a: 1 });
}

function relativeLuminance(color: RgbaColor): number {
  const channel = (raw: number): number => {
    const value = raw / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
}

export function calculateContrastRatio(foreground: string, background: string): number | null {
  const parsedForeground = parseCssColor(foreground);
  const parsedBackground = parseCssColor(background);
  if (!parsedForeground || !parsedBackground) return null;
  const effectiveBackground = opaque(parsedBackground);
  const effectiveForeground = composite(parsedForeground, effectiveBackground);
  const foregroundLuminance = relativeLuminance(effectiveForeground);
  const backgroundLuminance = relativeLuminance(effectiveBackground);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function toHex(color: RgbaColor): string {
  const channel = (value: number): string => Math.round(clamp(value)).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function interpolate(from: RgbaColor, to: RgbaColor, amount: number): RgbaColor {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1,
  };
}

function minimumContrast(foreground: string, backgrounds: readonly string[]): number | null {
  const ratios = backgrounds.map((background) => calculateContrastRatio(foreground, background));
  if (ratios.some((ratio) => ratio === null)) return null;
  return Math.min(...(ratios as number[]));
}

function correctedCandidate(
  original: RgbaColor,
  target: RgbaColor,
  backgrounds: readonly string[],
  requiredRatio: number,
): { value: string; distance: number; ratio: number } | null {
  const targetValue = toHex(target);
  const targetRatio = minimumContrast(targetValue, backgrounds);
  if (targetRatio === null || targetRatio < requiredRatio) return null;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 28; index += 1) {
    const middle = (low + high) / 2;
    const value = toHex(interpolate(original, target, middle));
    const ratio = minimumContrast(value, backgrounds);
    if (ratio !== null && ratio >= requiredRatio) high = middle;
    else low = middle;
  }
  const color = interpolate(original, target, high);
  const value = toHex(color);
  const ratio = minimumContrast(value, backgrounds);
  if (ratio === null) return null;
  const distance = Math.hypot(color.r - original.r, color.g - original.g, color.b - original.b);
  return { value, distance, ratio };
}

function ensureContrast(
  value: string,
  backgrounds: readonly string[],
  requiredRatio: number,
): { value: string; ratio: number } | null {
  const currentRatio = minimumContrast(value, backgrounds);
  if (currentRatio === null) return null;
  if (currentRatio >= requiredRatio) return { value, ratio: currentRatio };
  const original = parseCssColor(value);
  if (!original) return null;
  const opaqueOriginal = opaque(original);
  const candidates = [
    correctedCandidate(opaqueOriginal, { r: 0, g: 0, b: 0, a: 1 }, backgrounds, requiredRatio),
    correctedCandidate(opaqueOriginal, { r: 255, g: 255, b: 255, a: 1 }, backgrounds, requiredRatio),
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  candidates.sort((a, b) => a.distance - b.distance);
  const selected = candidates[0];
  return selected ? { value: selected.value, ratio: selected.ratio } : null;
}

function mostLegibleText(background: string): string {
  const black = calculateContrastRatio('#000000', background) ?? 1;
  const white = calculateContrastRatio('#ffffff', background) ?? 1;
  return black >= white ? '#000000' : '#ffffff';
}

/** Seed a semantic UI palette for a version-1 theme from its known terminal
 * roles. Missing values inherit the supplied product palette, never mutable
 * global/CSS state. */
export function seedUiThemeColors(theme: ThemeDefinition, fallback: UiThemeColors): UiThemeColors {
  const term = theme.cssVars;
  const canvas = term['--term-bg'] ?? theme.xterm.background ?? fallback.canvas;
  const surface = term['--term-bg-raised'] ?? canvas;
  const surfaceInset = term['--term-bg-inset'] ?? canvas;
  const textPrimary = term['--term-fg'] ?? theme.xterm.foreground ?? fallback.textPrimary;
  const textSecondary = term['--term-fg-dim'] ?? textPrimary;
  const textMuted = term['--term-fg-faint'] ?? textSecondary;
  const accent = term['--term-green'] ?? theme.swatch?.accent ?? fallback.accent;
  return {
    canvas,
    surface,
    surfaceRaised: term['--term-bg-raised'] ?? surface,
    surfaceInset,
    textPrimary,
    textSecondary,
    textMuted,
    textInverse: mostLegibleText(canvas),
    borderSubtle: term['--term-border-faint'] ?? fallback.borderSubtle,
    borderStrong: term['--term-border'] ?? fallback.borderStrong,
    accent,
    onAccent: mostLegibleText(accent),
    focus: accent,
    info: term['--term-blue'] ?? term['--term-cyan'] ?? fallback.info,
    success: term['--term-green'] ?? fallback.success,
    warning: term['--term-amber'] ?? fallback.warning,
    danger: term['--term-red'] ?? fallback.danger,
  };
}

export function uiThemeColorsToCssVars(ui: UiThemeColors): Readonly<Record<string, string>> {
  return Object.fromEntries(
    (Object.keys(UI_CSS_VAR_NAMES) as (keyof UiThemeColors)[]).map((role) => [UI_CSS_VAR_NAMES[role], ui[role]]),
  );
}

/** Produce an effective palette without mutating the registered/source theme.
 * Each role moves only as far toward black or white as needed to satisfy its
 * strictest functional surface. */
export function resolveAccessibleTheme(
  theme: ThemeDefinition,
  fallbackUi: UiThemeColors,
): { theme: ThemeDefinition; adjustments: readonly ThemeAdjustment[] } {
  const ui: UiThemeColors = { ...(theme.ui ?? seedUiThemeColors(theme, fallbackUi)) };
  const adjustments: ThemeAdjustment[] = [];
  const surfaces = [ui.canvas, ui.surface, ui.surfaceRaised, ui.surfaceInset];

  const correctUi = (role: keyof UiThemeColors, backgrounds: readonly string[], requiredRatio: number): void => {
    const before = ui[role];
    const corrected = ensureContrast(before, backgrounds, requiredRatio);
    if (!corrected || corrected.value === before) return;
    ui[role] = corrected.value;
    adjustments.push({
      role,
      before,
      after: corrected.value,
      requiredRatio,
      achievedRatio: corrected.ratio,
    });
  };

  correctUi('textPrimary', surfaces, 4.5);
  correctUi('textSecondary', surfaces, 4.5);
  correctUi('textMuted', surfaces, 4.5);
  correctUi('borderStrong', [ui.surface, ui.surfaceRaised], 3);
  correctUi('accent', [ui.canvas, ui.surface, ui.surfaceRaised], 3);
  correctUi('focus', [ui.canvas, ui.surface, ui.surfaceRaised], 3);
  correctUi('info', [ui.surface, ui.surfaceRaised], 3);
  correctUi('success', [ui.surface, ui.surfaceRaised], 3);
  correctUi('warning', [ui.surface, ui.surfaceRaised], 3);
  correctUi('danger', [ui.surface, ui.surfaceRaised], 3);
  correctUi('onAccent', [ui.accent], 4.5);

  const background = theme.xterm.background ?? ui.canvas;
  let foreground = theme.xterm.foreground ?? ui.textPrimary;
  let cursor = theme.xterm.cursor ?? ui.focus;
  const correctedForeground = ensureContrast(foreground, [background], 4.5);
  if (correctedForeground && correctedForeground.value !== foreground) {
    adjustments.push({
      role: 'terminalForeground',
      before: foreground,
      after: correctedForeground.value,
      requiredRatio: 4.5,
      achievedRatio: correctedForeground.ratio,
    });
    foreground = correctedForeground.value;
  }
  const correctedCursor = ensureContrast(cursor, [background], 3);
  if (correctedCursor && correctedCursor.value !== cursor) {
    adjustments.push({
      role: 'terminalCursor',
      before: cursor,
      after: correctedCursor.value,
      requiredRatio: 3,
      achievedRatio: correctedCursor.ratio,
    });
    cursor = correctedCursor.value;
  }

  const hasCompleteEffectiveData =
    theme.ui !== undefined &&
    theme.xterm.background !== undefined &&
    theme.xterm.foreground !== undefined &&
    theme.xterm.cursor !== undefined;
  if (adjustments.length === 0 && hasCompleteEffectiveData) return { theme, adjustments };

  return {
    theme: {
      ...theme,
      ui,
      xterm: { ...theme.xterm, background, foreground, cursor },
    },
    adjustments,
  };
}
