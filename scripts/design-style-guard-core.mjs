import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const CSS_ROOTS = ['src/renderer', 'mobile/src'];
const SOURCE_ROOTS = ['src/renderer', 'mobile/src'];

/** These are the only files allowed to own literal CSS palette values. */
export const CSS_COLOR_FOUNDATIONS = Object.freeze([
  'src/renderer/styles/ui-tokens.css',
  'src/renderer/index.css',
  'src/renderer/mobile-shared.css',
  'mobile/src/mobile-decorative-tokens.css',
]);

/** The first-paint sheets also own terminal and CRT compatibility. Product
 * chrome lives in the other, guarded sheets. */
export const TERMINAL_CSS_FOUNDATIONS = Object.freeze([
  'src/renderer/styles/ui-tokens.css',
  'src/renderer/index.css',
  'src/renderer/mobile-shared.css',
]);

const SOURCE_COLOR_FOUNDATIONS = new Set([
  'src/renderer/themes.ts',
  'src/renderer/theme-contrast.ts',
  'src/renderer/effect-params.ts',
  'src/renderer/effects.ts',
  'src/renderer/xterm-runtime.ts',
  'mobile/src/theme.ts',
]);

const SOURCE_FONT_FOUNDATIONS = new Set([
  'src/renderer/fonts.ts',
  'src/renderer/themes.ts',
]);

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

function listFiles(root, roots, extensions) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && extensions.has(extname(target).toLowerCase())) {
        files.push(toPosix(relative(root, target)));
      }
    }
  };
  for (const repoRoot of roots) visit(resolve(root, ...repoRoot.split('/')));
  return files.sort();
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (value) => value.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function reportMatches(errors, repoPath, source, pattern, label, accept = () => true) {
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    if (accept(match)) errors.push(`${repoPath}:${lineAt(source, match.index)}: ${label}: ${match[0].trim()}`);
  }
}

function validateCss(repoPath, rawSource, errors) {
  const source = withoutComments(rawSource);
  const ownsColors = CSS_COLOR_FOUNDATIONS.includes(repoPath);
  const ownsTerminal = TERMINAL_CSS_FOUNDATIONS.includes(repoPath);

  if (!ownsColors) {
    reportMatches(
      errors,
      repoPath,
      source,
      /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(\s*(?!var\()/giu,
      'raw palette color; use a semantic token',
    );
    reportMatches(
      errors,
      repoPath,
      source,
      /(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|outline-color|fill|stroke)\s*:\s*(?:black|white|red|green|blue)\s*(?=;|\})/gimu,
      'named palette color; use a semantic token',
    );
  }

  if (!ownsTerminal) {
    reportMatches(
      errors,
      repoPath,
      source,
      /var\(\s*--term-[a-z-]+/giu,
      'terminal token in product chrome; use --ui-*',
    );
  }

  reportMatches(
    errors,
    repoPath,
    source,
    /(?:^|[;{])\s*font-family\s*:\s*([^;}]+)/gimu,
    'direct font stack; use --ui-font-*',
    (match) => {
      if (CSS_COLOR_FOUNDATIONS.includes(repoPath)) return false;
      const value = match[1].trim();
      return !/^(?:var\(|inherit\b|initial\b|unset\b)/iu.test(value);
    },
  );

  reportMatches(
    errors,
    repoPath,
    source,
    /\bz-index\s*:\s*(\d+)\b/giu,
    'high local z-index; use --ui-z-*',
    (match) => !TERMINAL_CSS_FOUNDATIONS.includes(repoPath) && Number(match[1]) >= 100,
  );
}

function validateSource(repoPath, rawSource, errors) {
  if (/\.(?:test|stories)\.[cm]?[jt]sx?$/iu.test(repoPath) || repoPath.endsWith('.d.ts')) return;
  const source = withoutComments(rawSource);

  if (!SOURCE_COLOR_FOUNDATIONS.has(repoPath)) {
    reportMatches(
      errors,
      repoPath,
      source,
      /(['"`])(?:#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\([^'"`]*\))\1/giu,
      'raw palette literal; use a semantic token or theme foundation',
    );
  }

  if (!SOURCE_FONT_FOUNDATIONS.has(repoPath)) {
    reportMatches(
      errors,
      repoPath,
      source,
      /\bfontFamily\s*:\s*(['"`])([^'"`]+)\1/giu,
      'direct font stack; use --ui-font-*',
      (match) => !match[2].trim().startsWith('var(--ui-font-'),
    );
  }

  reportMatches(
    errors,
    repoPath,
    source,
    /\bzIndex\s*:\s*(\d+)\b/giu,
    'high local zIndex; use --ui-z-*',
    (match) => Number(match[1]) >= 100,
  );
}

export function validateDesignStyles(root) {
  const errors = [];
  const cssFiles = listFiles(root, CSS_ROOTS, new Set(['.css']));
  const sourceFiles = listFiles(root, SOURCE_ROOTS, new Set(['.ts', '.tsx']));
  for (const repoPath of cssFiles) validateCss(repoPath, readFileSync(resolve(root, repoPath), 'utf8'), errors);
  for (const repoPath of sourceFiles) validateSource(repoPath, readFileSync(resolve(root, repoPath), 'utf8'), errors);

  if (errors.length > 0) throw new Error(`Design style guard failed:\n- ${errors.join('\n- ')}`);
  return { cssFiles: cssFiles.length, sourceFiles: sourceFiles.length };
}
