import { Check, ChevronLeft, Folder } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';
import { useLatestRequestGate } from '../../src/renderer/latest-request';
import { VirtualizedRows } from '../../src/renderer/VirtualizedRows';
import { joinPath, type FileEntry } from '../../src/shared/files';
import { MobileActionSheet } from './MobileActionSheet';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

/**
 * Read-only host directory browser used by mobile Agent project management.
 * It intentionally exposes no file mutation actions from MobileFileView.
 */
export function MobileAgentFolderPicker({
  transport,
  excludedRoots,
  onClose,
  onSelect,
}: {
  readonly transport: WsEzTerminalTransport;
  readonly excludedRoots: readonly string[];
  readonly onClose: () => void;
  readonly onSelect: (path: string) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [directories, setDirectories] = useState<readonly FileEntry[]>([]);
  const [roots, setRoots] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigationGate = useLatestRequestGate();
  const excluded = new Set(excludedRoots.map((root) => root.toLocaleLowerCase('en-US')));

  const loadRoots = useCallback(async (): Promise<void> => {
    const generation = navigationGate.begin();
    setLoading(true);
    setError(null);
    const next = await transport.listFileRoots().catch(() => null);
    if (!navigationGate.isCurrent(generation)) return;
    setLoading(false);
    if (!next) {
      setError(t('agentHub.projects.folderPickerFailed'));
      return;
    }
    setRoots(next);
    setCurrentPath(null);
    setParent(null);
    setDirectories([]);
  }, [navigationGate, t, transport]);

  const loadPath = useCallback(async (path: string): Promise<void> => {
    const generation = navigationGate.begin();
    setLoading(true);
    setError(null);
    const result = await transport.listFiles(path).catch(() => null);
    if (!navigationGate.isCurrent(generation)) return;
    setLoading(false);
    if (!result?.ok) {
      setError(t('agentHub.projects.folderPickerFailed'));
      return;
    }
    setRoots([]);
    setCurrentPath(result.path);
    setParent(result.parent);
    setDirectories(result.entries.filter((entry) => entry.kind === 'dir'));
  }, [navigationGate, t, transport]);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const rows = useMemo(() => currentPath === null
    ? roots.map((root) => ({ path: root, label: root }))
    : directories.map((entry) => ({
        path: joinPath(currentPath, entry.name),
        label: entry.name,
      })), [currentPath, directories, roots]);

  return (
    <MobileActionSheet
      title={t('agentHub.projects.folderPickerTitle')}
      onClose={onClose}
      variant="fullscreen"
      testId="mobile-agent-folder-picker"
      className="mob-agent-folder-picker"
    >
      <div className="mob-agent-folder-picker__toolbar">
        {currentPath !== null && (
          <button
            type="button"
            className="mob-icon-btn"
            aria-label={t('common.back')}
            onClick={() => {
              if (parent) void loadPath(parent);
              else void loadRoots();
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        )}
        <span title={currentPath ?? undefined}>
          {currentPath ?? t('agentHub.projects.hostRoots')}
        </span>
        {currentPath && (
          <button
            type="button"
            className="mob-cta"
            disabled={excluded.has(currentPath.toLocaleLowerCase('en-US'))}
            onClick={() => onSelect(currentPath)}
            data-testid="mobile-agent-select-folder"
          >
            <Check aria-hidden="true" />
            {t('agentHub.projects.selectFolder')}
          </button>
        )}
      </div>
      {loading && <p className="mob-empty">{t('common.loading')}</p>}
      {error && (
        <div className="mob-agent-error" role="alert">
          <span>{error}</span>
          <button type="button" className="mob-btn-ghost" onClick={() => void loadRoots()}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {!loading && !error && (
        <VirtualizedRows
          items={rows}
          estimateSize={48}
          className="mob-agent-folder-picker__list"
          getKey={(row) => row.path}
          renderItem={(row) => (
            <button
              type="button"
              className="mob-row"
              onClick={() => void loadPath(row.path)}
            >
              <Folder aria-hidden="true" />
              <span><strong>{row.label}</strong></span>
            </button>
          )}
        >
          {(currentPath === null ? roots.length === 0 : directories.length === 0) && (
            <p className="mob-empty">{t('agentHub.projects.noFolders')}</p>
          )}
        </VirtualizedRows>
      )}
    </MobileActionSheet>
  );
}
