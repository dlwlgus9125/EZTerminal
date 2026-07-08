import { z } from 'zod';

import { isBuiltinTheme } from './layout-schema';
import { EFFECT_CATALOG } from '../renderer/effects';

/**
 * Theme mod schema (theme-effects-font M0) — the JSON shape an external
 * theme file/paste must conform to before it becomes a live ThemeDefinition
 * (renderer/themes.ts's registry). Mods are validated DATA, never executable
 * CSS/JS (plan Principle 2): `id` is a closed charset (no CSS-selector
 * breakout), `cssVars` keys are limited to the `--term-*` custom-property
 * namespace the app actually reads, and `cssVars`/`xterm`/`swatch` VALUES are
 * restricted to color literals — no `url()`, no `;`/`{`/`}` that could
 * smuggle extra declarations into the injected `<style>` block a later wave
 * writes these into.
 *
 * Shared by desktop (theme-store.ts folder-scan + Import) AND mobile (Import
 * only) — kept dependency-light (zod + the effect catalog ids only) so both
 * bundles can pull it in cheaply.
 */

export const THEME_SCHEMA_VERSION = 1 as const;

/** Hard cap enforced BEFORE JSON.parse (see `validateThemeMod`) — a theme mod
 * is a small, hand-authored color palette; anything past this is either
 * corrupt or hostile (e.g. a resource-exhaustion payload), so it's rejected
 * without ever reaching the parser. */
export const MAX_THEME_MOD_BYTES = 64 * 1024;

// ── color-literal value guard (cssVars + xterm + swatch all route through this) ──

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_COLOR_RE = /^(?:rgba?|hsla?)\([^()]*\)$/i;
// Explicit reject list (belt-and-suspenders over the allow-list below): a
// value containing any of these can never be a bare color literal, and
// rejecting on sight keeps the intent legible at the call site.
const DANGEROUS_VALUE_RE = /url\(|;|\{|\}|expression/i;

/** CSS named color keywords (+ `transparent`) — the only bare-word values
 * `isColorValue` accepts. A fixed, finite whitelist: every entry is a
 * literal this file owns, so there's no way a keyword doubles as an
 * injection vector. */
const CSS_NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'grey', 'green',
  'greenyellow', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
  'whitesmoke', 'yellow', 'yellowgreen', 'transparent',
]);

export function isColorValue(value: string): boolean {
  if (DANGEROUS_VALUE_RE.test(value)) return false;
  if (HEX_COLOR_RE.test(value)) return true;
  if (FUNC_COLOR_RE.test(value)) return true;
  return CSS_NAMED_COLORS.has(value.toLowerCase());
}

const ColorValueSchema = z.string().refine(isColorValue, {
  message: 'must be a hex/rgb(a)/hsl(a)/named color literal',
});

// ── id: the CSS-selector-safety-critical field ───────────────────────────────

/** `--term-*` custom-property namespace — the only keys `cssVars` may set
 * (matches what index.css's `[data-theme]` blocks actually read). */
const CSS_VAR_KEY_RE = /^--term-[a-z-]+$/;

const ThemeIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase alphanumeric/hyphen, starting with a letter or digit')
  .refine((id) => !isBuiltinTheme(id), {
    message: 'id collides with a built-in theme id (dark/light/high-contrast/matrix) — built-ins always win',
  });

// Xterm ITheme subset already used by renderer/themes.ts's built-ins — only
// background/foreground/cursor/cursorAccent/selectionBackground are ever set
// there (the 16 ANSI colors are intentionally left at xterm's defaults, see
// themes.ts's Matrix comment). `.strictObject`: an unknown key here (e.g. a
// typo'd ANSI color name) is rejected rather than silently ignored.
const XtermThemeSchema = z.strictObject({
  foreground: ColorValueSchema.optional(),
  background: ColorValueSchema.optional(),
  cursor: ColorValueSchema.optional(),
  cursorAccent: ColorValueSchema.optional(),
  selectionBackground: ColorValueSchema.optional(),
});

const CssVarsSchema = z.record(
  z.string().regex(CSS_VAR_KEY_RE, 'cssVars keys must match --term-<name>'),
  ColorValueSchema,
);

export const ThemeModSchema = z.strictObject({
  schemaVersion: z.literal(THEME_SCHEMA_VERSION),
  id: ThemeIdSchema,
  name: z.string().min(1).max(128),
  cssVars: CssVarsSchema,
  xterm: XtermThemeSchema,
  fontFamily: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^;{}<>]*$/, 'fontFamily contains disallowed characters')
    .optional(),
  fontSize: z.number().min(6).max(72).optional(),
  // Catalog membership is enforced in validateThemeMod (filter+warn, not a
  // hard reject — AC-E6) rather than here, so a mod referencing a future or
  // typo'd effect id still registers with its colors intact.
  effects: z.array(z.string()).optional(),
  swatch: z.strictObject({ bg: ColorValueSchema, accent: ColorValueSchema }).optional(),
});

export type ThemeMod = z.infer<typeof ThemeModSchema>;

const KNOWN_EFFECT_IDS = new Set<string>(Object.keys(EFFECT_CATALOG));

export type ValidateThemeModResult = { ok: true; theme: ThemeMod } | { ok: false; error: string };

/**
 * Full validate pipeline for a theme mod: size cap -> JSON.parse -> schema ->
 * effect-id filtering. Never throws — every failure mode (oversize, invalid
 * JSON, schema violation) routes through the `ok: false` branch so callers
 * (desktop folder-scan, desktop/mobile Import) can skip-and-warn without a
 * try/catch of their own.
 */
export function validateThemeMod(input: string): ValidateThemeModResult {
  if (new TextEncoder().encode(input).length > MAX_THEME_MOD_BYTES) {
    return { ok: false, error: `theme mod exceeds the ${MAX_THEME_MOD_BYTES}-byte limit` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = ThemeModSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: detail };
  }
  const theme = parsed.data;
  const effects = theme.effects?.filter((id) => {
    if (KNOWN_EFFECT_IDS.has(id)) return true;
    console.warn(`theme "${theme.id}": unknown effect id "${id}" ignored`);
    return false;
  });
  return { ok: true, theme: { ...theme, effects } };
}
