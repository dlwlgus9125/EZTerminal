import {
  BookOpenText,
  Database,
  File,
  FileArchive,
  FileCheck2,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileLock2,
  FileTerminal,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  Package,
  Table2,
  type LucideIcon,
} from 'lucide-react';

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
  readonly Icon: LucideIcon;
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
  Icon: LucideIcon,
): FileSystemEntryVisual {
  return { Icon, category, iconKey };
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
      ? visual('folder-open', 'folder', FolderOpen)
      : visual('folder', 'folder', Folder);
  }

  const basename = basenameOf(name);
  const extension = extensionOf(basename);

  if (/^(?:changelog|license|readme)(?:[._-]|$)/u.test(basename)) {
    return visual('document', 'document', BookOpenText);
  }
  if (basename === 'package.json') return visual('package', 'config', Package);
  if (LOCK_FILENAMES.has(basename) || /^bun\.lock(?:b|\.|$)/u.test(basename)) {
    return visual('lock', 'config', FileLock2);
  }
  if (isConfigFilename(basename)) return visual('config', 'config', FileCog);
  if (isTestFilename(basename)) return visual('test', 'test', FileCheck2);
  if (CODE_EXTENSIONS.has(extension)) return visual('code', 'code', FileCode2);
  if (WEB_EXTENSIONS.has(extension)) return visual('web', 'code', FileType2);
  if (TERMINAL_EXTENSIONS.has(extension)) return visual('terminal', 'code', FileTerminal);
  if (JSON_EXTENSIONS.has(extension)) return visual('json', 'config', FileJson2);
  if (CONFIG_EXTENSIONS.has(extension)) return visual('config', 'config', FileCog);
  if (DOCUMENT_EXTENSIONS.has(extension)) return visual('document', 'document', FileText);
  if (extension === 'csv' || extension === 'tsv') return visual('table', 'config', Table2);
  if (extension === 'sql') return visual('database', 'code', Database);
  if (IMAGE_EXTENSIONS.has(extension)) return visual('image', 'media', FileImage);
  if (ARCHIVE_EXTENSIONS.has(extension)) return visual('archive', 'media', FileArchive);
  return visual('file', 'generic', File);
}

export function FileSystemEntryIcon({
  name,
  kind,
  expanded = false,
  size = 16,
  className,
}: FileSystemEntryIconProps): JSX.Element {
  const visualState = resolveFileSystemEntryVisual(name, kind, expanded);
  const Icon = visualState.Icon;
  return (
    <span
      className={['file-system-entry-icon', className].filter(Boolean).join(' ')}
      data-category={visualState.category}
      data-icon={visualState.iconKey}
      data-entry-kind={kind}
      aria-hidden="true"
    >
      <Icon size={size} />
    </span>
  );
}
