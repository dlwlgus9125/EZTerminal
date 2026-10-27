import postcss from 'postcss';

// Android 10's WebView 74 (Chrome 74) lays out `gap` on grid containers but
// ignores it on flex containers, and CSS.supports cannot tell the two apart.
// The phone measures it at start-up (mobile/src/webview-compat.ts) and marks
// <html data-ui-flex-gap="unsupported">; every flex gap the phone ships needs a
// `[data-ui-flex-gap='unsupported'] <selector> { gap: 0 }` rule next to the
// margins that replace it (see src/renderer/mobile-shared.css).

export const DEFAULT_BASELINE_REASON = 'pending fallback (I5)';

const UNSUPPORTED_PREFIX = /^(?:html|:root)?\[data-ui-flex-gap=unsupported\] (.+)$/u;
// Only these at-rules scope a style rule. Rules under any other at-rule are
// skipped: @keyframes/@font-face hold no layout, and WebView 74 drops
// @container and @layer blocks entirely.
const SCOPE_AT_RULES = new Set(['media', 'supports']);
// The grid-* names are legacy aliases; modern engines apply them to flex too.
const GAP_AXES = new Map([
  ['gap', ['row', 'column']],
  ['grid-gap', ['row', 'column']],
  ['row-gap', ['row']],
  ['grid-row-gap', ['row']],
  ['column-gap', ['column']],
  ['grid-column-gap', ['column']],
]);
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const ZERO_GAP = /^(?:[+-]?(?:0+(?:\.0*)?|\.0+)[a-z%]*|normal)$/iu;

function isZeroGap(value) {
  return ZERO_GAP.test(value.trim());
}

function closingIndex(text, openIndex) {
  const open = text[openIndex];
  const close = open === '(' ? ')' : ']';
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === open) depth += 1;
    else if (text[index] === close && (depth -= 1) === 0) return index;
  }
  return text.length - 1;
}

/** The minifier drops attribute quotes and the spaces around combinators. */
export function normalizeSelector(selector) {
  return selector
    .replace(/\s+/gu, ' ')
    .replace(/\[ ?([^\]=]*?) ?= ?(["'])(.*?)\2 ?\]/gu, '[$1=$3]')
    .replace(/ ?([>+~,]) ?/gu, '$1')
    .trim();
}

function normalizeParams(params) {
  return params.replace(/\s+/gu, ' ').replace(/ ?([(),:]) ?/gu, '$1').trim();
}

function lastCompound(selector) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '\\') index += 1;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (depth === 0 && ' >+~'.includes(character)) start = index + 1;
  }
  return selector.slice(start);
}

/**
 * The element a selector styles: its last compound without pseudo-classes or
 * attribute filters, so `.a[data-x] .b:hover` and `.b` share the key `.b`.
 */
export function subjectKey(selector) {
  const compound = lastCompound(normalizeSelector(selector));
  let type = '';
  let pseudoElement = '';
  const simple = [];
  const attributes = [];
  for (let index = 0; index < compound.length;) {
    const character = compound[index];
    if (character === '[') {
      const end = closingIndex(compound, index);
      attributes.push(compound.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (character === ':') {
      const element = compound[index + 1] === ':';
      const nameStart = index + (element ? 2 : 1);
      let end = nameStart;
      while (end < compound.length && /[\w-]/u.test(compound[end])) end += 1;
      const name = compound.slice(nameStart, end).toLowerCase();
      if (compound[end] === '(') end = closingIndex(compound, end) + 1;
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) pseudoElement = `::${name}`;
      index = end;
      continue;
    }
    let end = index + 1;
    while (end < compound.length && !'.#[:'.includes(compound[end])) end += compound[end] === '\\' ? 2 : 1;
    const part = compound.slice(index, end);
    if (character === '.' || character === '#') simple.push(part);
    else type = part.toLowerCase();
    index = end;
  }
  const typePart = type === '*' && simple.length > 0 ? '' : type;
  const base = `${typePart}${simple.sort().join('')}` || attributes.sort().join('') || '*';
  return `${base}${pseudoElement}`;
}

/** Class names a selector needs on the page; a class under :not() does not. */
export function classTokens(selector) {
  let text = '';
  for (let index = 0; index < selector.length;) {
    if (selector.startsWith(':not(', index)) {
      index = closingIndex(selector, index + 4) + 1;
    } else if (selector[index] === '[') {
      index = closingIndex(selector, index) + 1;
    } else {
      text += selector[index];
      index += 1;
    }
  }
  return [...text.matchAll(/\.(-?[A-Za-z_][\w-]*)/gu)].map((match) => match[1]);
}

function ruleScope(rule) {
  const scope = [];
  for (let node = rule.parent; node && node.type !== 'root'; node = node.parent) {
    if (node.type !== 'atrule') continue;
    const name = node.name.toLowerCase();
    if (!SCOPE_AT_RULES.has(name)) return null;
    scope.unshift(`@${name} ${normalizeParams(node.params)}`);
  }
  return scope;
}

function displayKind(rule) {
  let kind = null;
  rule.each((node) => {
    if (node.type !== 'decl' || node.prop.toLowerCase() !== 'display') return;
    const value = node.value.trim().toLowerCase();
    if (value === 'flex' || value === 'inline-flex') kind = 'flex';
    else if (value === 'grid' || value === 'inline-grid') kind = 'grid';
    else kind = null;
  });
  return kind;
}

/** Per axis: true = a non-zero gap, false = gap reset to zero, absent = not set. */
function gapAxes(rule) {
  const axes = {};
  rule.each((node) => {
    if (node.type !== 'decl') return;
    const targets = GAP_AXES.get(node.prop.toLowerCase());
    if (!targets) return;
    const values = postcss.list.space(node.value);
    targets.forEach((axis, index) => {
      const value = targets.length === 2 ? (values[index] ?? values[0]) : node.value;
      axes[axis] = !isZeroGap(value);
    });
  });
  return axes;
}

function setsMargin(rule) {
  return rule.some((node) => node.type === 'decl' && /^margin(?:-|$)/iu.test(node.prop));
}

function scopeKey(selector, scope) {
  return scope.length > 0 ? `${scope.join(' ')} { ${selector} }` : selector;
}

function isScopePrefix(prefix, scope) {
  return prefix.length <= scope.length && prefix.every((part, index) => part === scope[index]);
}

function sameScope(left, right) {
  return left.length === right.length && isScopePrefix(left, right);
}

/** Class-name tokens and dynamic class prefixes (`foo--${x}`, `"foo-"+x`) in the phone bundles. */
function collectJsClassNames(jsSources) {
  const tokens = new Set();
  const prefixes = new Set();
  for (const source of jsSources) {
    for (const match of source.matchAll(/[A-Za-z_][\w-]*/gu)) tokens.add(match[0]);
    for (const match of source.matchAll(/(?<![\w-])([A-Za-z_][\w-]*[-_])(?:\$\{|["'`]\s*\+)/gu)) {
      // A one-word prefix (`mobile-${id}`) is almost always an id, not a class family.
      const prefix = match[1];
      if (/(?:--|__)$/u.test(prefix) || /[-_]/u.test(prefix.replace(/[-_]+$/u, ''))) prefixes.add(prefix);
    }
  }
  const prefixList = [...prefixes];
  return (token) => tokens.has(token) || prefixList.some((prefix) => token.startsWith(prefix));
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (value) => value.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Inline style objects such as `style={{ display: 'flex', gap: 8 }}`. */
export function findInlineFlexGaps(source) {
  const code = withoutComments(source);
  const lines = [];
  for (const match of code.matchAll(/\{[^{}]*\}/gu)) {
    const body = match[0];
    if (!/\bdisplay\s*:\s*(["'`])(?:inline-)?flex\1/u.test(body)) continue;
    const gaps = [...body.matchAll(/\b(?:gap|rowGap|columnGap)\s*:\s*([^,}\n]+)/gu)];
    if (gaps.some((gap) => !isZeroGap(gap[1].trim().replace(/^(["'`])(.*)\1$/u, '$2')))) {
      lines.push(lineAt(code, match.index));
    }
  }
  return lines;
}

/**
 * @param {{ cssFiles: { path: string, source: string }[], jsSources: string[], tsxFiles?: { path: string, source: string }[] }} input
 */
export function analyzeMobileCss({ cssFiles, jsSources, tsxFiles = [] }) {
  const displayKinds = new Map();
  const gapRules = new Map();
  const fallbacks = new Map();
  const marginRules = [];

  for (const file of cssFiles) {
    postcss.parse(file.source, { from: file.path }).walkRules((rule) => {
      const scope = ruleScope(rule);
      if (!scope) return;
      const display = displayKind(rule);
      const axes = gapAxes(rule);
      const margin = setsMargin(rule);
      for (const raw of rule.selectors) {
        const selector = normalizeSelector(raw);
        if (display) {
          const key = subjectKey(selector);
          if (!displayKinds.has(key)) displayKinds.set(key, new Set());
          displayKinds.get(key).add(display);
        }
        const inner = UNSUPPORTED_PREFIX.exec(selector)?.[1];
        if (inner) {
          if (axes.row === false || axes.column === false) {
            if (!fallbacks.has(inner)) fallbacks.set(inner, []);
            fallbacks.get(inner).push({ scope, row: axes.row === false, column: axes.column === false });
          }
          if (margin) marginRules.push(inner);
          continue;
        }
        if (!axes.row && !axes.column) continue;
        const key = scopeKey(selector, scope);
        const existing = gapRules.get(key);
        if (existing) {
          existing.axes.row ||= Boolean(axes.row);
          existing.axes.column ||= Boolean(axes.column);
          existing.files.add(file.path);
        } else {
          gapRules.set(key, {
            key, selector, scope, axes: { row: Boolean(axes.row), column: Boolean(axes.column) }, files: new Set([file.path]),
          });
        }
      }
    });
  }

  const isShipped = collectJsClassNames(jsSources);
  const violations = [];
  const warnings = [];
  let flexGapSelectors = 0;
  let unreachable = 0;
  let withFallback = 0;

  for (const rule of [...gapRules.values()].sort((left, right) => (left.key < right.key ? -1 : 1))) {
    const kinds = displayKinds.get(subjectKey(rule.selector));
    if (!kinds?.has('flex')) continue;
    const kind = kinds.has('grid') ? 'ambiguous' : 'flex';
    flexGapSelectors += 1;
    if (!classTokens(rule.selector).every(isShipped)) {
      unreachable += 1;
      continue;
    }
    const covered = { row: false, column: false };
    for (const fallback of fallbacks.get(rule.selector) ?? []) {
      const inScope = kind === 'ambiguous' ? sameScope(fallback.scope, rule.scope) : isScopePrefix(fallback.scope, rule.scope);
      if (!inScope) continue;
      covered.row ||= fallback.row;
      covered.column ||= fallback.column;
    }
    if ((rule.axes.row && !covered.row) || (rule.axes.column && !covered.column)) {
      violations.push({ key: rule.key, kind, selector: rule.selector, scope: rule.scope, files: [...rule.files].sort() });
      continue;
    }
    withFallback += 1;
    if (!marginRules.some((inner) => inner.startsWith(`${rule.selector}>`))) {
      warnings.push(`${rule.key}: gap is reset for WebView 74 but no \`> *\` margin rule replaces it`);
    }
  }

  for (const file of tsxFiles) {
    const lines = findInlineFlexGaps(file.source);
    if (lines.length === 0) continue;
    violations.push({ key: `inline style in ${file.path} (${lines.length})`, kind: 'inline', files: [file.path], lines });
  }

  return { flexGapSelectors, unreachable, withFallback, violations, warnings };
}

export function parseBaseline(text) {
  const entries = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error('the baseline must be a JSON array');
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry?.selector !== 'string' || typeof entry.reason !== 'string') {
      throw new Error(`baseline entry needs a string selector and reason: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry.selector)) throw new Error(`baseline lists ${entry.selector} twice`);
    seen.add(entry.selector);
  }
  return entries;
}

/** New violations fail, and so do baseline entries that no longer violate: the list only shrinks. */
export function compareBaseline(violationKeys, baseline) {
  const listed = new Set(baseline.map((entry) => entry.selector));
  const current = new Set(violationKeys);
  return {
    added: [...current].filter((key) => !listed.has(key)).sort(),
    stale: [...listed].filter((key) => !current.has(key)).sort(),
  };
}

export function updateBaseline(violationKeys, baseline) {
  const reasons = new Map(baseline.map((entry) => [entry.selector, entry.reason]));
  return [...new Set(violationKeys)].sort().map((selector) => ({
    selector,
    reason: reasons.get(selector) ?? DEFAULT_BASELINE_REASON,
  }));
}

export function formatBaseline(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}
