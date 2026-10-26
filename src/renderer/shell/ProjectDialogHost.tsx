import { useEffect, useRef } from 'react';

import type { AgentProjectSummary } from '../../shared/agent-history';
import { ProjectDeleteDialog, ProjectEditorDialog, type ProjectRegistryAccess } from '../ProjectDialogs';

/** Which project dialog is open: one at a time (one modal layer). */
export type ProjectDialogState =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly project: AgentProjectSummary }
  | { readonly kind: 'delete'; readonly project: AgentProjectSummary };

export interface ProjectDialogHostProps {
  readonly state: ProjectDialogState | null;
  readonly onStateChange: (next: ProjectDialogState | null) => void;
  readonly access: ProjectRegistryAccess;
  /** A project was added or edited (`previousProjectId` when editing; a new primary folder changes the id). */
  readonly onSaved: (project: AgentProjectSummary, kind: 'add' | 'edit', previousProjectId?: string) => void;
  readonly onDeleted: (projectId: string) => void;
}

const ADD = { kind: 'add' } as const;

/**
 * The project dialogs of the shell, opened from the top bar, the board and conversations.
 * Focus goes back to what opened the first of them once the last one closes.
 */
export function ProjectDialogHost({ state, onStateChange, access, onSaved, onDeleted }: ProjectDialogHostProps): JSX.Element | null {
  const invoker = useRef<HTMLElement | null>(null);
  const open = state !== null;
  useEffect(() => {
    if (open) {
      if (!invoker.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        invoker.current = document.activeElement;
      }
      return;
    }
    const target = invoker.current;
    invoker.current = null;
    if (!target) return;
    // After the closing dialog's own focus restore, which may point into a dialog that is gone.
    requestAnimationFrame(() => { if (target.isConnected) target.focus(); });
  }, [open]);

  const close = (): void => onStateChange(null);

  if (!state) return null;
  if (state.kind === 'delete') {
    return (
      <ProjectDeleteDialog
        project={state.project}
        access={access}
        onClose={close}
        onDeleted={(projectId) => { onDeleted(projectId); close(); }}
      />
    );
  }
  return (
    <ProjectEditorDialog
      open
      mode={state.kind === 'add' ? ADD : { kind: 'edit', project: state.project }}
      access={access}
      onClose={close}
      onSaved={(project, previousProjectId) => { onSaved(project, state.kind, previousProjectId); close(); }}
    />
  );
}
