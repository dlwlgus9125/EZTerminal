import { describe, expect, it } from 'vitest';

import {
  projectEditorDocumentParametersEqual,
  projectEditorDocumentPathKey,
  projectEditorDocumentsEqual,
  projectEditorTitle,
  type ProjectEditorDocument,
} from './project-editor-model';

function document(lens?: ProjectEditorDocument['lens']): ProjectEditorDocument {
  return {
    projectId: 'project-1',
    rootId: 'root-1',
    workspaceId: 'workspace-1',
    relativePath: 'src/app.ts',
    ...(lens ? { lens } : {}),
  };
}

describe('project editor document identity', () => {
  it('uses the real project path rather than the transient comparison lens as tab identity', () => {
    const plain = document();
    const current = document({ kind: 'current' });
    const turn = document({ kind: 'agent-turn', historyId: 'history-1', turnId: 'turn-1' });

    expect(projectEditorDocumentsEqual(current, plain)).toBe(true);
    expect(projectEditorDocumentsEqual(turn, plain)).toBe(true);
  });

  it('prefers the main-owned canonical key over renderer path normalization', () => {
    const canonicalKey = 'canonical-project-document-key';
    const resolved: ProjectEditorDocument = {
      ...document({ kind: 'agent-turn', historyId: 'history-1', turnId: 'turn-1' }),
      relativePath: 'SRC/App.ts',
      documentKey: canonicalKey,
    };

    expect(projectEditorDocumentsEqual(
      resolved,
      { ...resolved, relativePath: 'src/app.ts' },
    )).toBe(true);
  });

  it('matches a canonical target to its legacy persisted path without duplicating the tab', () => {
    const legacy = { ...document(), relativePath: 'src\\app.ts' };
    const resolved = { ...document(), documentKey: 'project-document:sha256' };

    expect(projectEditorDocumentPathKey(legacy)).toBe(projectEditorDocumentPathKey(resolved));
    expect(projectEditorDocumentsEqual(legacy, resolved)).toBe(true);
    expect(projectEditorDocumentsEqual(
      { ...legacy, workspaceId: 'other-workspace' },
      resolved,
    )).toBe(false);
    expect(projectEditorDocumentsEqual(
      { ...legacy, documentKey: 'project-document:first' },
      { ...resolved, documentKey: 'project-document:second' },
    )).toBe(false);
  });

  it('uses the actual file name for current and Agent-turn lenses', () => {
    expect(projectEditorTitle(document({ kind: 'current' }))).toBe('app.ts');
    expect(projectEditorTitle(document({
      kind: 'agent-turn',
      historyId: 'history-1',
      turnId: 'turn-1',
    }))).toBe('app.ts');
  });

  it('skips a parameter update for the same current presentation but keeps lens changes', () => {
    const resolved = { ...document(), documentKey: 'project-document:sha256' };

    expect(projectEditorDocumentParametersEqual(
      resolved,
      { ...resolved, lens: { kind: 'current' } },
    )).toBe(true);
    expect(projectEditorDocumentParametersEqual(
      resolved,
      {
        ...resolved,
        lens: { kind: 'agent-turn', historyId: 'history-1', turnId: 'turn-1' },
      },
    )).toBe(false);
    expect(projectEditorDocumentParametersEqual(
      resolved,
      { ...resolved, documentKey: 'project-document:new-key' },
    )).toBe(false);
  });
});
