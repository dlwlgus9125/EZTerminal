import type { ProjectDocumentLens } from '../shared/project-workspace';

/** The one durable editor document: a real path in a validated project
 * workspace. Code and diff are presentations of this same document. */
export interface ProjectEditorDocument {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  /** Main-owned, case-normalized equality key when the target was resolved
   * through ProjectDocumentService. Older persisted layouts may omit it. */
  readonly documentKey?: string;
  /** Transient comparison lens. It is never part of identity or persistence. */
  readonly lens?: ProjectDocumentLens;
}

export function projectEditorDocumentKey(document: ProjectEditorDocument): string {
  if (document.documentKey) return document.documentKey;
  return projectEditorDocumentPathKey(document);
}

/** Compatibility identity for layouts persisted before main-owned keys. Keep
 * this exact and workspace-qualified: main remains the sole casing authority. */
export function projectEditorDocumentPathKey(document: ProjectEditorDocument): string {
  return [
    document.projectId,
    document.rootId,
    document.workspaceId,
    document.relativePath.replace(/\\/gu, '/'),
  ].join('\0');
}

export function projectEditorDocumentsEqual(
  left: ProjectEditorDocument,
  right: ProjectEditorDocument,
): boolean {
  if (left.documentKey && right.documentKey) return left.documentKey === right.documentKey;
  return projectEditorDocumentPathKey(left) === projectEditorDocumentPathKey(right);
}

/** Whether updating Dockview params would change the loaded presentation.
 * An omitted lens is the default current-file lens. */
export function projectEditorDocumentParametersEqual(
  left: ProjectEditorDocument,
  right: ProjectEditorDocument,
): boolean {
  if (!projectEditorDocumentsEqual(left, right)
    || left.projectId !== right.projectId
    || left.rootId !== right.rootId
    || left.workspaceId !== right.workspaceId
    || left.relativePath !== right.relativePath
    || left.documentKey !== right.documentKey) {
    return false;
  }
  const leftLens = left.lens ?? { kind: 'current' as const };
  const rightLens = right.lens ?? { kind: 'current' as const };
  if (leftLens.kind !== rightLens.kind) return false;
  return leftLens.kind === 'current'
    || (rightLens.kind === 'agent-turn'
      && leftLens.historyId === rightLens.historyId
      && leftLens.turnId === rightLens.turnId);
}

export function projectEditorTitle(document: ProjectEditorDocument): string {
  return document.relativePath.split('/').pop() ?? document.relativePath;
}
