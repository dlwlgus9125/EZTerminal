import { FolderPlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { AgentProjectFolderSelection, AgentProjectSummary } from '../shared/agent-history';
import type { EzTerminalApi } from '../shared/ipc';
import { useAppTranslation } from './i18n';
import { Button, Dialog, Field, IconButton, Input } from './ui';

/** The project registry as the project dialogs use it; injected so stories and tests can fake it. */
export interface ProjectRegistryAccess {
  readonly listAgentProjects: EzTerminalApi['listAgentProjects'];
  readonly saveAgentProject: EzTerminalApi['saveAgentProject'];
  readonly removeAgentProject: EzTerminalApi['removeAgentProject'];
  /** The native folder picker (desktop only); without it folders cannot be chosen here. */
  readonly selectFolders?: (multiple?: boolean) => Promise<AgentProjectFolderSelection>;
}

const PAGE_SIZE = 100;

/** The registry has no lookup by id: its pages are read until the project turns up. */
export async function findAgentProject(
  list: ProjectRegistryAccess['listAgentProjects'],
  projectId: string,
): Promise<AgentProjectSummary | null> {
  let cursor: string | undefined;
  for (;;) {
    const page = await list(false, cursor, PAGE_SIZE);
    const found = page.items.find((project) => project.projectId === projectId);
    if (found) return found;
    if (!page.nextCursor || page.nextCursor === cursor) return null;
    cursor = page.nextCursor;
  }
}

/** The folder's own name: the last segment of its path. */
export function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}

/** Appends folders not already listed (Windows paths compare without case). */
export function withFolders(current: readonly string[], added: readonly string[]): readonly string[] {
  const seen = new Set(current.map((root) => root.toLocaleLowerCase('en-US')));
  return [
    ...current,
    ...added.filter((root) => {
      const key = root.toLocaleLowerCase('en-US');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export type ProjectEditorMode =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly project: AgentProjectSummary };

/**
 * Adds a project (its folders are chosen here, the name follows the first one until it is typed)
 * or edits one: its name and folders, the first being the primary.
 */
export function ProjectEditorDialog({ open, mode, access, onClose, onSaved, onOpenArchive }: {
  readonly open: boolean;
  readonly mode: ProjectEditorMode;
  readonly access: ProjectRegistryAccess;
  readonly onClose: () => void;
  /** `previousProjectId`: the edited project's id before saving (a new primary folder changes it). */
  readonly onSaved: (project: AgentProjectSummary, previousProjectId?: string) => void;
  /** The project's backup and restore (editing only, where the host offers it). */
  readonly onOpenArchive?: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const editing = mode.kind === 'edit' ? mode.project : null;
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameTouched = useRef(false);

  // Every opening starts from the project as saved, or from nothing.
  useEffect(() => {
    if (!open) return;
    nameTouched.current = false;
    setName(editing?.name ?? '');
    setRoots(editing ? [editing.primaryRoot, ...editing.additionalRoots] : []);
    setSaving(false);
    setError(null);
  }, [open, editing]);

  const applyRoots = (next: readonly string[]): void => {
    setRoots(next);
    if (!editing && !nameTouched.current) setName(next[0] ? folderName(next[0]) : '');
  };

  const chooseFolders = async (): Promise<void> => {
    if (!access.selectFolders) return;
    const selection = await access.selectFolders(true).catch(() => null);
    if (!selection || selection.canceled || selection.paths.length === 0) return;
    applyRoots(withFolders(roots, selection.paths));
  };

  const save = async (): Promise<void> => {
    const [primaryRoot, ...additionalRoots] = roots;
    const trimmed = name.trim();
    if (!primaryRoot || !trimmed || saving) return;
    setSaving(true);
    setError(null);
    const result = await access.saveAgentProject({
      ...(editing ? { projectId: editing.projectId } : {}),
      name: trimmed,
      primaryRoot,
      additionalRoots,
      pinned: editing?.pinned ?? false,
    }).catch(() => ({ ok: false, reason: 'invalid' } as const));
    setSaving(false);
    if (!result.ok) {
      setError(t('agentHub.projects.saveFailed'));
      return;
    }
    onSaved(result.project, editing?.projectId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !saving) onClose(); }}
      title={editing ? t('agentHub.projects.editorEditTitle') : t('agentHub.projects.editorAddTitle')}
      closeLabel={t('common.cancel')}
      testId="agent-project-editor"
      footer={(
        <>
          {editing && onOpenArchive && (
            <Button variant="ghost" onClick={onOpenArchive} disabled={saving} data-testid="agent-project-backup" className="agent-project-editor__backup">
              {t('agentHub.projects.backupRestore')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || !name.trim() || roots.length === 0}
            data-testid="agent-project-save"
          >
            {saving ? t('agentHub.projects.saving') : t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="agent-project-editor">
        <Field label={t('agentHub.projects.name')} required>
          <Input
            value={name}
            onChange={(event) => { nameTouched.current = true; setName(event.currentTarget.value); }}
            autoComplete="off"
            data-testid="agent-project-name"
          />
        </Field>
        <div className="agent-project-roots">
          <span className="agent-project-roots__label">{t('agentHub.projects.roots')}</span>
          {roots.length === 0 && (editing
            ? <p className="agent-project-error" role="alert">{t('agentHub.projects.selectPrimary')}</p>
            : <p className="agent-project-note">{t('agentHub.projects.selectPrimary')}</p>)}
          <ol>
            {roots.map((root, index) => (
              <li key={root}>
                <div>
                  <strong>{index === 0 ? t('agentHub.projects.primary') : `+${index}`}</strong>
                  <span title={root}>{root}</span>
                </div>
                {index > 0 && (
                  <div className="agent-project-root-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => applyRoots([root, ...roots.filter((candidate) => candidate !== root)])}
                    >
                      {t('agentHub.projects.setPrimary')}
                    </Button>
                    <IconButton
                      icon={X}
                      aria-label={`${t('agentHub.projects.removeFolder')}: ${root}`}
                      onClick={() => applyRoots(roots.filter((candidate) => candidate !== root))}
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
          {access.selectFolders && (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<FolderPlus aria-hidden="true" />}
              onClick={() => void chooseFolders()}
              data-testid="agent-project-add-folder"
            >
              {t('agentHub.projects.addFolder')}
            </Button>
          )}
        </div>
        {error && <p className="agent-project-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

/** Removes a project from EZTerminal (its folders and provider history stay where they are). */
export function ProjectDeleteDialog({ project, access, onClose, onDeleted }: {
  readonly project: AgentProjectSummary | null;
  readonly access: ProjectRegistryAccess;
  readonly onClose: () => void;
  readonly onDeleted: (projectId: string) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setBusy(false); setError(null); }, [project]);

  const remove = async (): Promise<void> => {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    const removed = await access.removeAgentProject(project.projectId).catch(() => false);
    setBusy(false);
    if (!removed) {
      setError(t('agentHub.projects.deleteFailed'));
      return;
    }
    onDeleted(project.projectId);
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      title={t('agentHub.projects.deleteTitle', { name: project?.name ?? '' })}
      description={t('agentHub.projects.deleteDescription')}
      role="alertdialog"
      tone="danger"
      size="sm"
      closeLabel={t('common.cancel')}
      testId="agent-project-delete"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t('agentHub.projects.deleteConfirm')}
          </Button>
        </>
      )}
    >
      {error && <p className="agent-project-error" role="alert">{error}</p>}
    </Dialog>
  );
}
