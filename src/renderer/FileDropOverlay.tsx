import { useEffect, useMemo, useRef, useState } from 'react';

import { quoteEzArgument } from '../shared/quote-ez-argument';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { useNativeOverlayRegistration } from './native-overlay';
import { getPaneHandle } from './pane-registry';
import { useToast } from './ui';

export const EZTERMINAL_PATHS_MIME = 'application/x-ezterminal-paths';
export const MAX_DROPPED_PATHS = 20;

function supportsPathDrop(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return [...dataTransfer.types].includes('Files') || [...dataTransfer.types].includes(EZTERMINAL_PATHS_MIME);
}

function quotePtyPath(value: string): string {
  if (/^[^\s"']+$/u.test(value)) return value;
  return `"${value.replace(/"/gu, '\\"')}"`;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = path.toLocaleLowerCase('en-US');
    if (!path || seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

export function setInternalPathDrag(dataTransfer: DataTransfer, paths: readonly string[]): void {
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData(EZTERMINAL_PATHS_MIME, JSON.stringify(uniquePaths(paths).slice(0, MAX_DROPPED_PATHS)));
  dataTransfer.setData('text/plain', paths.join('\n'));
}

export interface FileDropOverlayProps {
  readonly activePanelId: string | null;
  readonly agentSessionIds: ReadonlySet<string>;
  readonly capabilities?: CapabilityAccess;
}

export function FileDropOverlay({
  activePanelId,
  agentSessionIds,
  capabilities = rendererCapabilities,
}: FileDropOverlayProps): JSX.Element | null {
  const { t, i18n } = useAppTranslation();
  const [dragDepth, setDragDepth] = useState(0);
  useNativeOverlayRegistration(dragDepth > 0);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const maxDroppedPaths = useMemo(
    () => new Intl.NumberFormat(locale).format(MAX_DROPPED_PATHS),
    [locale],
  );
  const { pushToast } = useToast();
  // Read through a ref: the drop listeners are registered once, and depending on
  // pushToast directly would re-subscribe them on every provider render.
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  const activePanelIdRef = useRef(activePanelId);
  activePanelIdRef.current = activePanelId;
  const agentSessionsRef = useRef(agentSessionIds);
  agentSessionsRef.current = agentSessionIds;

  useEffect(() => {
    const showToast = (message: string): void => {
      pushToastRef.current({ title: message, variant: 'warning' });
    };
    const onDragEnter = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      event.preventDefault();
      setDragDepth((depth) => depth + 1);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      setDragDepth((depth) => Math.max(0, depth - 1));
    };
    const onDrop = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      event.preventDefault();
      setDragDepth(0);
      const transfer = event.dataTransfer;
      if (!transfer) return;
      const paths: string[] = [];
      const internal = transfer.getData(EZTERMINAL_PATHS_MIME);
      if (internal) {
        try {
          const parsed: unknown = JSON.parse(internal);
          if (Array.isArray(parsed)) {
            for (const value of parsed) if (typeof value === 'string') paths.push(value);
          }
        } catch {
          showToast(t('fileDrop.invalidData'));
          return;
        }
      }
      for (const file of [...transfer.files]) {
        const path = capabilities.files.pathForDrop(file);
        if (path) paths.push(path);
      }
      const unique = uniquePaths(paths);
      if (unique.length === 0) {
        showToast(t('fileDrop.noPaths'));
        return;
      }
      if (unique.length > MAX_DROPPED_PATHS) {
        showToast(t('fileDrop.tooManyPaths', { value: maxDroppedPaths }));
        return;
      }
      const panelId = activePanelIdRef.current;
      const pane = panelId ? getPaneHandle(panelId) : undefined;
      if (!pane) {
        showToast(t('fileDrop.noActiveTerminal'));
        return;
      }
      const snapshot = pane.getSnapshot();
      if (snapshot.isDead) {
        showToast(t('fileDrop.terminalEnded'));
        return;
      }
      if (snapshot.activePty) {
        if (!snapshot.sessionId || !agentSessionsRef.current.has(snapshot.sessionId)) {
          showToast(t('fileDrop.nonAgentDisabled'));
          return;
        }
        const result = pane.pasteToPty(unique.map(quotePtyPath).join(' '));
        if (!result.ok) showToast(t('fileDrop.agentPasteFailed'));
        return;
      }
      if (snapshot.isBusy) {
        showToast(t('fileDrop.waitForCommand'));
        return;
      }
      const result = pane.insertText(unique.map(quoteEzArgument).join(' '));
      if (!result.ok) showToast(t('fileDrop.insertFailed'));
    };

    window.addEventListener('dragenter', onDragEnter, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [capabilities, maxDroppedPaths, t]);

  if (dragDepth <= 0) return null;
  return (
    <div className="file-drop-overlay" aria-hidden="true" data-testid="file-drop-overlay">
      <span>{t('fileDrop.prompt')}</span>
      <small>{t('fileDrop.safety')}</small>
    </div>
  );
}
