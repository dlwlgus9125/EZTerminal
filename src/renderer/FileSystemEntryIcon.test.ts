import { describe, expect, it } from 'vitest';

import { resolveFileSystemEntryVisual } from './FileSystemEntryIcon';

describe('resolveFileSystemEntryVisual', () => {
  it('uses distinct closed and open folder visuals', () => {
    expect(resolveFileSystemEntryVisual('src', 'directory')).toMatchObject({
      category: 'folder',
      iconKey: 'folder',
    });
    expect(resolveFileSystemEntryVisual('src', 'directory', true)).toMatchObject({
      category: 'folder',
      iconKey: 'folder-open',
    });
  });

  it.each([
    ['README.md', 'document', 'document'],
    ['Dockerfile.dev', 'config', 'config'],
    ['.gitignore', 'config', 'config'],
    ['.env.local', 'config', 'config'],
    ['package.json', 'package', 'config'],
    ['pnpm-lock.yaml', 'lock', 'config'],
    ['bun.lockb', 'lock', 'config'],
    ['vite.config.ts', 'config', 'config'],
  ] as const)('maps special filename %s to %s', (name, iconKey, category) => {
    expect(resolveFileSystemEntryVisual(name, 'file')).toMatchObject({ iconKey, category });
  });

  it.each([
    ['APP.TSX', 'code', 'code'],
    ['styles.scss', 'web', 'code'],
    ['setup.ps1', 'terminal', 'code'],
    ['settings.jsonc', 'json', 'config'],
    ['schema.yaml', 'config', 'config'],
    ['notes.mdx', 'document', 'document'],
    ['logo.svg', 'image', 'media'],
    ['source.tar.gz', 'archive', 'media'],
    ['rows.csv', 'table', 'config'],
    ['query.sql', 'database', 'code'],
  ] as const)('maps extension for %s to %s', (name, iconKey, category) => {
    expect(resolveFileSystemEntryVisual(name, 'file')).toMatchObject({ iconKey, category });
  });

  it('gives test names priority over their code extension', () => {
    expect(resolveFileSystemEntryVisual('src/app.spec.tsx', 'file')).toMatchObject({
      category: 'test',
      iconKey: 'test',
    });
    expect(resolveFileSystemEntryVisual('TEST_WORKSPACE.PY', 'file')).toMatchObject({
      category: 'test',
      iconKey: 'test',
    });
  });

  it('falls back for unknown and extensionless files', () => {
    expect(resolveFileSystemEntryVisual('NOTICE.custom', 'file')).toMatchObject({
      category: 'generic',
      iconKey: 'file',
    });
    expect(resolveFileSystemEntryVisual('mystery', 'file')).toMatchObject({
      category: 'generic',
      iconKey: 'file',
    });
  });
});
