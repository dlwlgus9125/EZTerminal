import { useEffect, useRef, useState } from 'react';

import type { AgentProjectSummary } from '../../shared/agent-history';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { GitDiffResult } from '../../shared/git-status';
import type { WorkspaceWorktreeAccess } from '../../shared/workspace-worktree';
import { ProjectDeleteDialog, ProjectEditorDialog, type ProjectRegistryAccess } from '../ProjectDialogs';
import type { useLiveTerminalSessions } from '../use-live-terminal-sessions';
import { NewWorktreeDialog } from '../WorktreeDialogs';
import { AllProjectsDialog } from './AllProjectsDialog';
import { WorktreeDiffDialog, WorktreeMergeStep, WorktreesDialog, type ProjectWorktree } from './WorktreesDialog';

/** A project as the worktree dialogs need it. */
export interface ProjectRef {
  readonly projectId: string;
  readonly name: string;
}

/**
 * Which project dialog is open: one at a time (one modal layer). A dialog opened from the
 * project list goes back to it (`returnTo`) when it is cancelled or done.
 */
export type ProjectDialogState =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly returnTo?: 'list' }
  | { readonly kind: 'edit'; readonly project: AgentProjectSummary; readonly returnTo?: 'list' }
  | { readonly kind: 'delete'; readonly project: AgentProjectSummary; readonly returnTo?: 'list' }
  | { readonly kind: 'worktrees'; readonly project: ProjectRef }
  | { readonly kind: 'worktree-new'; readonly project: ProjectRef; readonly returnTo?: 'worktrees' }
  | { readonly kind: 'merge'; readonly project: ProjectRef; readonly worktree: ProjectWorktree }
  | { readonly kind: 'diff'; readonly project: ProjectRef; readonly worktree: ProjectWorktree };

export interface ProjectDialogHostProps {
  readonly state: ProjectDialogState | null;
  readonly onStateChange: (next: ProjectDialogState | null) => void;
  readonly access: ProjectRegistryAccess;
  /** Absent where worktrees cannot be made (not the desktop host). */
  readonly worktrees?: WorkspaceWorktreeAccess;
  /** The host's state: which worktrees there are and what runs in them. */
  readonly snapshot?: DaemonSnapshot | null;
  /** Which terminals still run (for what a worktree cleanup would stop). */
  readonly terminals?: Parameters<typeof useLiveTerminalSessions>[0];
  /** git's view of a worktree's changes (the merge dialog's 변경 검토). */
  readonly loadDiff?: (directory: string) => Promise<GitDiffResult>;
  /** A project was added or edited (`previousProjectId` when editing; a new primary folder changes the id). */
  readonly onSaved: (project: AgentProjectSummary, kind: 'add' | 'edit', previousProjectId?: string) => void;
  readonly onDeleted: (projectId: string) => void;
  /** A pin changed in the list. */
  readonly onChanged: () => void;
  /** The list's project was chosen: its board opens. */
  readonly onOpenBoard: (project: AgentProjectSummary) => void;
  /** The list's CLI 기록: that project's CLI records in the history dialog. */
  readonly onCliHistory: (project: AgentProjectSummary) => void;
  /** A new worktree is ready: a conversation starts there. */
  readonly onWorktreeCreated: (project: ProjectRef, workspaceId: string) => void;
}

const ADD = { kind: 'add' } as const;
const LIST = { kind: 'list' } as const;

/**
 * The project dialogs of the shell, opened from the top bar, the board and conversations.
 * Focus goes back to what opened the first of them once the last one closes.
 */
export function ProjectDialogHost(props: ProjectDialogHostProps): JSX.Element | null {
  const { state, onStateChange, access } = props;
  const invoker = useRef<HTMLElement | null>(null);
  // Bumped whenever a list is returned to after a change, so it reads the registry or git again.
  const [listRevision, setListRevision] = useState(0);
  const [worktreesRevision, setWorktreesRevision] = useState(0);
  // The new-worktree dialog closes the same way when cancelled and when done: this tells them apart.
  const worktreeCreated = useRef(false);
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

  if (!state) return null;
  const close = (): void => onStateChange(null);
  // Back to the dialog this one was opened from, read again when something changed.
  const back = (changed: boolean): void => {
    const returnTo = 'returnTo' in state ? state.returnTo : undefined;
    if (returnTo === 'list') {
      if (changed) setListRevision((value) => value + 1);
      onStateChange(LIST);
    } else if (returnTo === 'worktrees' && 'project' in state) {
      if (changed) setWorktreesRevision((value) => value + 1);
      onStateChange({ kind: 'worktrees', project: state.project });
    } else close();
  };
  const backToWorktrees = (project: ProjectRef): void => {
    setWorktreesRevision((value) => value + 1);
    onStateChange({ kind: 'worktrees', project });
  };

  switch (state.kind) {
    case 'list':
      return (
        <AllProjectsDialog
          access={access}
          reloadKey={listRevision}
          onClose={close}
          onOpen={(project) => { close(); props.onOpenBoard(project); }}
          {...(access.selectFolders ? { onAdd: () => onStateChange({ kind: 'add', returnTo: 'list' }) } : {})}
          onEdit={(project) => onStateChange({ kind: 'edit', project, returnTo: 'list' })}
          onCliHistory={(project) => { close(); props.onCliHistory(project); }}
          onDelete={(project) => onStateChange({ kind: 'delete', project, returnTo: 'list' })}
          onChanged={props.onChanged}
        />
      );
    case 'delete':
      return (
        <ProjectDeleteDialog
          project={state.project}
          access={access}
          onClose={() => back(false)}
          onDeleted={(projectId) => { props.onDeleted(projectId); back(true); }}
        />
      );
    case 'worktrees': {
      const { worktrees } = props;
      if (!worktrees) return null;
      return (
        <WorktreesDialog
          project={state.project}
          snapshot={props.snapshot ?? null}
          worktrees={worktrees}
          reloadKey={worktreesRevision}
          onClose={close}
          onNew={() => onStateChange({ kind: 'worktree-new', project: state.project, returnTo: 'worktrees' })}
          onMerge={(worktree) => onStateChange({ kind: 'merge', project: state.project, worktree })}
        />
      );
    }
    case 'worktree-new': {
      const { worktrees } = props;
      if (!worktrees) return null;
      return (
        <NewWorktreeDialog
          open
          onOpenChange={(next) => {
            if (next) return;
            // Made: its conversation opens, nothing to go back to. Cancelled: back where it came from.
            if (worktreeCreated.current) { worktreeCreated.current = false; close(); } else back(false);
          }}
          projectName={state.project.name}
          onCreate={async (branch) => {
            const created = await worktrees.create(state.project.projectId, branch);
            if (created.ok) {
              worktreeCreated.current = true;
              props.onWorktreeCreated(state.project, created.value.workspaceId);
            }
            return created;
          }}
        />
      );
    }
    case 'merge': {
      const { worktrees, loadDiff } = props;
      if (!worktrees) return null;
      return (
        <WorktreeMergeStep
          project={state.project}
          worktree={state.worktree}
          snapshot={props.snapshot ?? null}
          worktrees={worktrees}
          {...(props.terminals ? { terminals: props.terminals } : {})}
          onClose={() => backToWorktrees(state.project)}
          {...(loadDiff ? { onReview: () => onStateChange({ kind: 'diff', project: state.project, worktree: state.worktree }) } : {})}
        />
      );
    }
    case 'diff': {
      const { loadDiff } = props;
      if (!loadDiff) return null;
      return (
        <WorktreeDiffDialog
          worktree={state.worktree}
          loadDiff={loadDiff}
          onClose={() => onStateChange({ kind: 'merge', project: state.project, worktree: state.worktree })}
        />
      );
    }
    case 'add':
    case 'edit':
      return (
        <ProjectEditorDialog
          open
          mode={state.kind === 'add' ? ADD : { kind: 'edit', project: state.project }}
          access={access}
          onClose={() => back(false)}
          onSaved={(project, previousProjectId) => {
            props.onSaved(project, state.kind, previousProjectId);
            // A new project opens its board; an edit made from the list goes back to it.
            if (state.kind === 'add') close();
            else back(true);
          }}
        />
      );
  }
}
