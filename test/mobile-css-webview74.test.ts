import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASELINE_REASON,
  analyzeMobileCss,
  compareBaseline,
  findInlineFlexGaps,
  parseBaseline,
  subjectKey,
  updateBaseline,
} from '../scripts/mobile-css-webview74-core.mjs';

const SHIPPED_JS = 'const a="row list both grid card wide panel";';

function analyze(css: string, js = SHIPPED_JS, tsxFiles: { path: string, source: string }[] = []) {
  return analyzeMobileCss({ cssFiles: [{ path: 'main.css', source: css }], jsSources: [js], tsxFiles });
}

function keys(css: string, js?: string) {
  return analyze(css, js).violations.map((violation: { key: string }) => violation.key);
}

describe('mobile CSS WebView 74 flex-gap check', () => {
  it('flags a flex gap, ignores a grid gap and marks a key that is both as ambiguous', () => {
    const result = analyze([
      '.row{display:flex;gap:8px}',
      '.grid{display:grid;gap:8px}',
      '.both{display:flex}',
      '@media(min-width:600px){.both{display:grid}}',
      '.both{gap:4px}',
      '.panel{gap:0}',
      '.card{gap:normal;display:flex}',
    ].join(''));
    expect(result.violations.map((violation: { key: string, kind: string }) => [violation.key, violation.kind])).toEqual([
      ['.both', 'ambiguous'],
      ['.row', 'flex'],
    ]);
  });

  it('finds flex on another rule for the same element, ignoring pseudo-classes and attributes', () => {
    expect(subjectKey('.list[data-open=true] .row:hover')).toBe('.row');
    expect(subjectKey('.list > .row.wide:not(.grid)')).toBe('.row.wide');
    expect(subjectKey('.row:before')).toBe('.row::before');
    expect(subjectKey('.toolbar [role="group"]')).toBe('[role=group]');
    expect(keys('.row{display:flex}.list[data-open=true] .row:hover{gap:4px}')).toEqual(['.list[data-open=true] .row:hover']);
  });

  it('recognises the minified, unquoted fallback and its margin rule', () => {
    const minified = analyze('.row{display:flex;gap:8px}[data-ui-flex-gap=unsupported] .row{gap:0}[data-ui-flex-gap=unsupported] .row>*+*{margin-left:8px}');
    expect(minified.violations).toEqual([]);
    expect(minified.withFallback).toBe(1);
    expect(minified.warnings).toEqual([]);

    const source = analyze(`
      .list > .row { display: flex; gap: 8px; }
      [data-ui-flex-gap='unsupported'] .list>.row { gap: 0; }
      [data-ui-flex-gap="unsupported"]   .list > .row > * + * { margin-left: 8px; }
    `);
    expect(source.violations).toEqual([]);
    expect(source.warnings).toEqual([]);
  });

  it('warns, without failing, when a reset gap has no margin rule', () => {
    const result = analyze('.row{display:flex;gap:8px}[data-ui-flex-gap=unsupported] .row{gap:0}');
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('.row: gap is reset')]);
  });

  it('requires the reset on every axis the gap uses', () => {
    expect(keys('.row{display:flex;gap:0 8px}[data-ui-flex-gap=unsupported] .row{column-gap:0}')).toEqual([]);
    expect(keys('.row{display:flex;gap:8px}[data-ui-flex-gap=unsupported] .row{row-gap:0}')).toEqual(['.row']);
    expect(keys('.row{display:flex;grid-gap:8px}')).toEqual(['.row']);
  });

  it('matches the fallback against the media scope', () => {
    // A top-level reset outranks a scoped flex gap; a scoped reset does not cover the top level.
    expect(keys('.row{display:flex}@media (max-width: 600px){.row{gap:8px}}[data-ui-flex-gap=unsupported] .row{gap:0}')).toEqual([]);
    expect(keys('.row{display:flex;gap:8px}@media(max-width:600px){[data-ui-flex-gap=unsupported] .row{gap:0}}')).toEqual(['.row']);
    expect(keys('.row{display:flex}@media (max-width: 600px){.row{gap:8px}}@media(max-width:600px){[data-ui-flex-gap=unsupported] .row{gap:0}}')).toEqual([]);

    // An ambiguous (also grid) element must be reset in the scope that makes it flex, not everywhere.
    const ambiguous = '.both{display:grid}@media(max-width:600px){.both{display:flex;gap:8px}}';
    expect(keys(`${ambiguous}[data-ui-flex-gap=unsupported] .both{gap:0}`)).toEqual(['@media (max-width:600px) { .both }']);
    expect(keys(`${ambiguous}@media (max-width: 600px){[data-ui-flex-gap='unsupported'] .both{gap:0}}`)).toEqual([]);
  });

  it('skips rules inside at-rules WebView 74 drops', () => {
    expect(keys('@container (max-width: 40rem){.row{display:flex;gap:8px}}')).toEqual([]);
    expect(keys('@supports not (inset-inline-end: 0){.row{display:flex;gap:8px}}')).toEqual(['@supports not(inset-inline-end:0) { .row }']);
  });

  it('only checks selectors whose classes the phone bundles use', () => {
    const css = '.row{display:flex;gap:8px}.gone{display:flex;gap:8px}.row .gone{display:flex;gap:4px}.row:not(.debug){display:flex;gap:2px}';
    const result = analyze(css);
    expect(result.violations.map((violation: { key: string }) => violation.key)).toEqual(['.row', '.row:not(.debug)']);
    expect(result.unreachable).toBe(2);
    expect(result.flexGapSelectors).toBe(4);
  });

  it('treats a dynamic class prefix as shipped, but not a one-word id prefix', () => {
    const css = '.row--wide{display:flex;gap:8px}.status-dot-ok{display:flex;gap:8px}.mobile-pc{display:flex;gap:8px}';
    const js = 'const a=`row--${size}`,b="status-dot-"+state,c=`mobile-${id}`;';
    const result = analyze(css, js);
    expect(result.violations.map((violation: { key: string }) => violation.key)).toEqual(['.row--wide', '.status-dot-ok']);
    expect(result.unreachable).toBe(1);
  });

  it('reports inline style objects that use a flex gap', () => {
    const source = [
      "export const A = () => <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} />;",
      'export const B = () => <div style={{ display: "inline-flex", columnGap: \'4px\' }} />;',
      "export const C = () => <div style={{ display: 'flex', gap: 0 }} />;",
      "export const D = () => <div style={{ display: 'grid', gap: 8 }} />;",
      "// <div style={{ display: 'flex', gap: 8 }} />",
    ].join('\n');
    expect(findInlineFlexGaps(source)).toEqual([1, 2]);
    const result = analyze('', SHIPPED_JS, [{ path: 'mobile/src/View.tsx', source }]);
    expect(result.violations).toEqual([
      { key: 'inline style in mobile/src/View.tsx (2)', kind: 'inline', files: ['mobile/src/View.tsx'], lines: [1, 2] },
    ]);
  });

  it('fails on new violations and on stale baseline entries, so the list only shrinks', () => {
    const baseline = parseBaseline(JSON.stringify([
      { selector: '.row', reason: 'pending fallback (I5)' },
      { selector: '.fixed', reason: 'kept for the bridge' },
    ]));
    expect(compareBaseline(['.row'], baseline)).toEqual({ added: [], stale: ['.fixed'] });
    expect(compareBaseline(['.row', '.new'], baseline)).toEqual({ added: ['.new'], stale: ['.fixed'] });
    expect(compareBaseline(['.row', '.fixed'], baseline)).toEqual({ added: [], stale: [] });
  });

  it('rewrites the baseline keeping existing reasons', () => {
    const baseline = [{ selector: '.row', reason: 'waits for the sheet rewrite' }, { selector: '.fixed', reason: 'x' }];
    expect(updateBaseline(['.zeta', '.row', '.row'], baseline)).toEqual([
      { selector: '.row', reason: 'waits for the sheet rewrite' },
      { selector: '.zeta', reason: DEFAULT_BASELINE_REASON },
    ]);
    expect(() => parseBaseline('[{"selector":".row","reason":"a"},{"selector":".row","reason":"b"}]')).toThrow('twice');
    expect(() => parseBaseline('{"selector":".row"}')).toThrow('JSON array');
  });
});
