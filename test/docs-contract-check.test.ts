import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTIVE_CONTRACTS,
  validateDocumentationContract,
} from '../scripts/docs-contract-check-core.mjs';

const roots: string[] = [];

function write(root: string, path: string, contents: string): void {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function contract(path: string): string {
  const prefix = path.startsWith('docs/') && path.split('/').length === 3 ? '../..' : '..';
  return [
    '# Contract',
    '',
    '> 문서 상태: **활성 규범 계약**',
    '',
    '## 근거 소스',
    '',
    `- [source](${prefix}/src/sample.ts)`,
    '',
    '## 검증',
    '',
    `- [test](${prefix}/src/sample.test.ts)`,
    '',
  ].join('\n');
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ezterminal-docs-check-'));
  roots.push(root);

  write(root, 'src/sample.ts', 'export const sample = true;\n');
  write(root, 'src/sample.test.ts', 'export const tested = true;\n');
  write(root, 'README.md', '# Readme\n\n[Architecture](docs/architecture.md)\n');
  write(root, 'docs/ROADMAP.md', '# Roadmap\n\n[Architecture](architecture.md)\n');
  write(root, 'docs/release/README.md', '# Release\n\n[Remote](../design/remote-desktop.md)\n');

  const architectureLinks = ACTIVE_CONTRACTS.map((path) => {
    const target = path.replace(/^docs\//u, '');
    return `- [${target}](${target})`;
  }).join('\n');
  write(root, 'docs/architecture.md', [
    '# Architecture',
    '',
    '> 문서 상태: **공식 아키텍처 진입점**',
    '',
    architectureLinks,
    '',
    '## 근거 소스',
    '',
    '- [source](../src/sample.ts)',
    '',
    '## 검증',
    '',
    '- [test](../src/sample.test.ts)',
    '',
  ].join('\n'));

  for (const path of ACTIVE_CONTRACTS) write(root, path, contract(path));

  write(root, 'docs/archive/design/legacy.md', '# Legacy\n');
  write(root, 'docs/archive/research/review.md', '# Review\n');
  write(root, 'docs/archive/README.md', '# Archive\n\ndesign/legacy.md\n\nresearch/\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('documentation contract check', () => {
  it('accepts a complete active/archive document map', () => {
    const result = validateDocumentationContract(makeFixture());
    expect(result.activeContracts).toBe(ACTIVE_CONTRACTS.length);
    expect(result.archivedDocuments).toBe(3);
  });

  it('rejects a broken local source link', () => {
    const root = makeFixture();
    write(root, 'docs/design/terminal-runtime.md', contract('docs/design/terminal-runtime.md').replace(
      '../../src/sample.ts',
      '../../src/missing.ts',
    ));
    expect(() => validateDocumentationContract(root)).toThrow('missing local target');
  });

  it('rejects an orphan active design document', () => {
    const root = makeFixture();
    write(root, 'docs/design/orphan.md', contract('docs/design/orphan.md'));
    expect(() => validateDocumentationContract(root)).toThrow('orphan active design document');
  });

  it('rejects removed document paths in active source', () => {
    const root = makeFixture();
    write(root, 'src/sample.ts', '// docs/research/old-review.md\n');
    expect(() => validateDocumentationContract(root)).toThrow('removed docs/research path');
  });

  it('rejects archived plan status in an active contract', () => {
    const root = makeFixture();
    write(root, 'docs/design/terminal-runtime.md', `${contract('docs/design/terminal-runtime.md')}\nStatus: GATED\n`);
    expect(() => validateDocumentationContract(root)).toThrow('contains archived plan status');
  });

  it('requires evidence and verification sections', () => {
    const root = makeFixture();
    write(root, 'docs/design/terminal-runtime.md', contract('docs/design/terminal-runtime.md').replace(
      '## 검증',
      '## 확인 결과',
    ));
    expect(() => validateDocumentationContract(root)).toThrow('missing required section "## 검증"');
  });

  it('requires archived design originals in the archive index', () => {
    const root = makeFixture();
    write(root, 'docs/archive/README.md', '# Archive\n\nresearch/\n');
    expect(() => validateDocumentationContract(root)).toThrow('archived design is not indexed');
  });
});
