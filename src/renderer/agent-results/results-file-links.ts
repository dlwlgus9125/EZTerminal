import { parseFileReference, type ResolveFileLink } from '../chat/markdown/file-links';
import { isAbsolutePath, isInsideWorkspace, isNetworkOrDevicePath, samePath } from './results-format';

/** Extensions a bare `name.ext` in prose must have to become a link; `e.g.` and `v1.2` stay text. */
const FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'txt', 'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'py', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'yml', 'yaml', 'toml',
  'xml', 'sql', 'sh', 'ps1', 'bat', 'cmd', 'ini', 'cfg', 'conf', 'env', 'lock', 'gradle', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'csv',
]);

/**
 * Which file references in the chat open in the Results tab: paths in the
 * working folder (relative ones resolve there) and paths the conversation's
 * change records name. Network shares, devices and paths that climb out of
 * the folder stay plain text.
 */
export function createResultsFileResolver(workspaceRoot: string | undefined, knownPaths: readonly string[]): ResolveFileLink {
  return (text) => {
    const target = parseFileReference(text.replace(/<WORKSPACE>[\\/]+/gu, ''));
    if (!target) return undefined;
    const path = target.path;
    if (isNetworkOrDevicePath(path)) return undefined;
    if (isAbsolutePath(path)) {
      return isInsideWorkspace(path, workspaceRoot) || knownPaths.some((known) => samePath(known, path)) ? target : undefined;
    }
    if (!workspaceRoot || /^(?:\.\.[\\/]|~)/u.test(path) || /^[A-Za-z]:/u.test(path)) return undefined;
    const hasFolder = /[\\/]/u.test(path.replace(/^\.[\\/]/u, ''));
    const extension = /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase();
    if (!hasFolder && !(extension && FILE_EXTENSIONS.has(extension))) return undefined;
    return target;
  };
}
