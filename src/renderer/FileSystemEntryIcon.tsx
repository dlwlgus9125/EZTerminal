import { Glyph, type GlyphName } from './ui';

export type FileSystemEntryKind = 'file' | 'directory';

export type FileSystemEntryCategory =
  | 'folder'
  | 'code'
  | 'config'
  | 'document'
  | 'test'
  | 'media'
  | 'generic';

export type FileSystemEntryIconKey =
  | 'folder'
  | 'folder-open'
  | 'code'
  | 'web'
  | 'terminal'
  | 'json'
  | 'config'
  | 'document'
  | 'test'
  | 'table'
  | 'database'
  | 'image'
  | 'archive'
  | 'lock'
  | 'package'
  | 'file';

export interface FileSystemEntryVisual {
  readonly glyph: GlyphName;
  readonly category: FileSystemEntryCategory;
  readonly iconKey: FileSystemEntryIconKey;
}

interface FileSystemEntryIconProps {
  readonly name: string;
  readonly kind: FileSystemEntryKind;
  readonly expanded?: boolean;
  readonly size?: number;
  readonly className?: string;
}

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'cxx', 'dart', 'fs', 'fsx', 'go', 'h', 'hpp', 'java',
  'js', 'jsx', 'kt', 'kts', 'lua', 'mjs', 'cjs', 'php', 'py', 'rb', 'rs', 'swift',
  'ts', 'tsx',
]);
const WEB_EXTENSIONS = new Set([
  'css', 'htm', 'html', 'less', 'sass', 'scss', 'svelte', 'vue',
]);
const TERMINAL_EXTENSIONS = new Set([
  'bash', 'bat', 'cmd', 'fish', 'ps1', 'sh', 'zsh',
]);
const JSON_EXTENSIONS = new Set(['json', 'json5', 'jsonc']);
const CONFIG_EXTENSIONS = new Set(['cfg', 'conf', 'ini', 'toml', 'xml', 'yaml', 'yml']);
const DOCUMENT_EXTENSIONS = new Set(['adoc', 'md', 'mdx', 'pdf', 'rst', 'txt']);
const IMAGE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp',
]);
const ARCHIVE_EXTENSIONS = new Set([
  '7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip',
]);
const LOCK_FILENAMES = new Set([
  'cargo.lock',
  'composer.lock',
  'package-lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
]);
const CONFIG_FILENAMES = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  'pnpm-workspace.yaml',
]);

function visual(
  iconKey: FileSystemEntryIconKey,
  category: FileSystemEntryCategory,
  glyph: GlyphName,
): FileSystemEntryVisual {
  return { glyph, category, iconKey };
}

function basenameOf(name: string): string {
  return name.split(/[\\/]/u).at(-1)?.toLowerCase() ?? name.toLowerCase();
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
}

function isConfigFilename(name: string): boolean {
  return /^dockerfile(?:[._-]|$)/u.test(name)
    || /^makefile(?:[._-]|$)/u.test(name)
    || /^\.env(?:\.|$)/u.test(name)
    || /^(?:ts|js)config(?:\..+)?\.json$/u.test(name)
    || name.includes('.config.')
    || name.endsWith('.config')
    || /^\.(?:babel|eslint|npm|prettier|stylelint|yarn)rc(?:\.|$)/u.test(name)
    || CONFIG_FILENAMES.has(name);
}

function isTestFilename(name: string): boolean {
  return /\.(?:spec|test)(?:\.|$)/u.test(name)
    || /^test_.+/u.test(name)
    || /_test(?:\.|$)/u.test(name);
}

export function resolveFileSystemEntryVisual(
  name: string,
  kind: FileSystemEntryKind,
  expanded = false,
): FileSystemEntryVisual {
  if (kind === 'directory') {
    return expanded
      ? visual('folder-open', 'folder', 'proj')
      : visual('folder', 'folder', 'proj');
  }

  const basename = basenameOf(name);
  const extension = extensionOf(basename);

  if (/^(?:changelog|license|readme)(?:[._-]|$)/u.test(basename)) {
    return visual('document', 'document', 'file');
  }
  if (basename === 'package.json') return visual('package', 'config', 'archive');
  if (LOCK_FILENAMES.has(basename) || /^bun\.lock(?:b|\.|$)/u.test(basename)) {
    return visual('lock', 'config', 'key');
  }
  if (isConfigFilename(basename)) return visual('config', 'config', 'set');
  if (isTestFilename(basename)) return visual('test', 'test', 'check');
  if (CODE_EXTENSIONS.has(extension)) return visual('code', 'code', 'code');
  if (WEB_EXTENSIONS.has(extension)) return visual('web', 'code', 'code');
  if (TERMINAL_EXTENSIONS.has(extension)) return visual('terminal', 'code', 'term');
  if (JSON_EXTENSIONS.has(extension)) return visual('json', 'config', 'code');
  if (CONFIG_EXTENSIONS.has(extension)) return visual('config', 'config', 'set');
  if (DOCUMENT_EXTENSIONS.has(extension)) return visual('document', 'document', 'file');
  if (extension === 'csv' || extension === 'tsv') return visual('table', 'config', 'list');
  if (extension === 'sql') return visual('database', 'code', 'server');
  if (IMAGE_EXTENSIONS.has(extension)) return visual('image', 'media', 'image');
  if (ARCHIVE_EXTENSIONS.has(extension)) return visual('archive', 'media', 'archive');
  return visual('file', 'generic', 'file');
}

export function FileSystemEntryIcon({
  name,
  kind,
  expanded = false,
  size = 16,
  className,
}: FileSystemEntryIconProps): JSX.Element {
  const visualState = resolveFileSystemEntryVisual(name, kind, expanded);
  return (
    <span
      className={['file-system-entry-icon', className].filter(Boolean).join(' ')}
      data-category={visualState.category}
      data-icon={visualState.iconKey}
      data-entry-kind={kind}
      aria-hidden="true"
    >
      <Glyph name={visualState.glyph} size={size} />
    </span>
  );
}
