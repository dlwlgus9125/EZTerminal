import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The phone scenarios hand JavaScript strings to the Android WebView. On Android 10 that is
 * WebView 74, which rejects `?.` and `??` (Chrome 80) with "Unexpected token" — a scenario that
 * passes on API 35 then fails on API 29 before it checks anything.
 */
const E2E_DIR = path.resolve(import.meta.dirname, '..', 'mobile', 'e2e');
const WEBVIEW_CODE = /document\.|window\.|querySelector|getComputedStyle|localStorage/;
const TOO_NEW = [/\?\.(?![0-9])/, /\?\?/];

function webViewSyntaxProblems(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      const code = ts.isTemplateExpression(node)
        ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
        : node.text;
      if (WEBVIEW_CODE.test(code) && TOO_NEW.some((pattern) => pattern.test(code))) {
        problems.push(`${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

describe('phone e2e WebView strings', () => {
  it('flags `?.` and `??` in code meant for the WebView', () => {
    expect(webViewSyntaxProblems('x.ts', "await evaluateWebView(`document.querySelector('a')?.id ?? null`);")).toEqual(['x.ts:1']);
    expect(webViewSyntaxProblems('x.ts', "const name = process.argv[2]?.trim() ?? '';")).toEqual([]);
  });

  it('uses only syntax WebView 74 runs', () => {
    const problems = readdirSync(E2E_DIR)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => webViewSyntaxProblems(name, readFileSync(path.join(E2E_DIR, name), 'utf8')));
    expect(problems).toEqual([]);
  });
});
