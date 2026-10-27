import { useState } from 'react';

import { useAppTranslation } from './i18n';
import { ProjectArchivePanel, type ProjectArchiveAccess } from './ProjectArchivePanel';
import type { ProjectArchivePendingStore } from './project-archive-pending';
import { Dialog, Glyph } from './ui';

/** What the backup dialog needs from its host: the archive requests and this device's unanswered one. */
export interface ProjectArchiveDialogAccess {
  readonly access: ProjectArchiveAccess;
  readonly pending: ProjectArchivePendingStore;
}

/**
 * A project's backup, restore and history cleanup in one dialog: on the PC from the project's settings,
 * on the phone from the project screen. An unanswered request is kept on this device and shown again.
 */
export function ProjectArchiveDialog({ project, archive, onClose, onOpenProject }: {
  readonly project: { readonly projectId: string; readonly name: string };
  readonly archive: ProjectArchiveDialogAccess;
  readonly onClose: () => void;
  /** A restored project: open it. */
  readonly onOpenProject?: (projectId: string) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [pending, setPending] = useState(() => archive.pending.read(project.projectId));
  return (
    <Dialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`${t('agentHub.projects.backupRestoreTitle')} · ${project.name}`}
      icon={<Glyph name="archive" size={20} />}
      className="ez-inst-dialog"
      size="lg"
      closeLabel={t('common.close')}
      testId="project-archive-dialog"
    >
      <ProjectArchivePanel
        projectId={project.projectId}
        access={archive.access}
        disabled={false}
        pendingRequest={pending}
        persistPendingRequest={async (request) => { await archive.pending.write(project.projectId, request); setPending(request); }}
        {...(onOpenProject ? { onOpenProject } : {})}
      />
    </Dialog>
  );
}
