import type {
  ProjectSessionPanelMetadata,
  ProjectWorkspaceDescriptor,
  ProjectWorkspaceLocationDescriptor,
} from '../shared/project-workspace';

function comparableAbsolutePath(value: string): string | null {
  if (!value || value.length > 32_768) return null;
  const windows = /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}/u.test(value);
  const slashed = windows ? value.replace(/\\/gu, '/') : value;
  const normalized = slashed === '/' || /^[A-Za-z]:\/$/u.test(slashed)
    ? slashed
    : slashed.replace(/\/+$/u, '');
  return windows ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function describedWorkspaces(
  descriptor: ProjectWorkspaceDescriptor,
): readonly ProjectWorkspaceLocationDescriptor[] {
  return descriptor.workspaces ?? descriptor.roots.map((root) => ({
    workspaceId: root.rootId,
    rootId: root.rootId,
    name: root.name,
    displayPath: root.displayPath,
    kind: 'root' as const,
    access: 'granted' as const,
  }));
}

/**
 * Recognizes only the exact root of a main-described, accessible workspace.
 * The returned opaque ids are re-resolved by main when the terminal binds;
 * display paths are used only to preserve the user's existing "open here"
 * intent and never become persisted authority.
 */
export function projectTerminalMetadataForDirectory(
  descriptor: ProjectWorkspaceDescriptor,
  directory: string,
): ProjectSessionPanelMetadata | null {
  const requestedPath = comparableAbsolutePath(directory);
  if (!requestedPath) return null;
  const workspace = describedWorkspaces(descriptor).find((candidate) => (
    candidate.access === 'granted'
    && comparableAbsolutePath(candidate.displayPath) === requestedPath
  ));
  if (!workspace) return null;
  return {
    projectId: descriptor.projectId,
    rootId: workspace.rootId,
    workspaceId: workspace.workspaceId,
    projectName: descriptor.name,
    titleMode: 'generated',
  };
}
