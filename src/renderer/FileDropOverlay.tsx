import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { quoteEzArgument } from '../shared/quote-ez-argument';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { addAppWindowEventListener } from './desktop-window-registry';
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

interface FileDragTarget {
  readonly ownerDocument: Document;
  readonly depth: number;
}

export function FileDropOverlay({
  activePanelId,
  agentSessionIds,
  capabilities = rendererCapabilities,
}: FileDropOverlayProps): JSX.Element | null {
  const { t, i18n } = useAppTranslation();
  const [dragTarget, setDragTarget] = useState<FileDragTarget | null>(null);
  useNativeOverlayRegistration(dragTarget !== null);
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
    const eventDocument = (event: Event): Document => (
      (event.currentTarget as Window | null)?.document ?? document
    );
    const showToast = (message: string, ownerDocument: Document): void => {
      pushToastRef.current({ title: message, variant: 'warning' }, ownerDocument);
    };
    const onDragEnter = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      event.preventDefault();
      const ownerDocument = eventDocument(event);
      setDragTarget((current) => current?.ownerDocument === ownerDocument
        ? { ownerDocument, depth: current.depth + 1 }
        : { ownerDocument, depth: 1 });
    };
    const onDragOver = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      const ownerDocument = eventDocument(event);
      setDragTarget((current) => {
        if (!current || current.ownerDocument !== ownerDocument) return current;
        return current.depth <= 1 ? null : { ownerDocument, depth: current.depth - 1 };
      });
    };
    const onDrop = (event: DragEvent): void => {
      if (!supportsPathDrop(event.dataTransfer)) return;
      event.preventDefault();
      const ownerDocument = eventDocument(event);
      setDragTarget(null);
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
          showToast(t('fileDrop.invalidData'), ownerDocument);
          return;
        }
      }
      for (const file of [...transfer.files]) {
        const path = capabilities.files.pathForDrop(file);
        if (path) paths.push(path);
      }
      const unique = uniquePaths(paths);
      if (unique.length === 0) {
        showToast(t('fileDrop.noPaths'), ownerDocument);
        return;
      }
      if (unique.length > MAX_DROPPED_PATHS) {
        showToast(t('fileDrop.tooManyPaths', { value: maxDroppedPaths }), ownerDocument);
        return;
      }
      const panelId = activePanelIdRef.current;
      const pane = panelId ? getPaneHandle(panelId) : undefined;
      if (!pane) {
        showToast(t('fileDrop.noActiveTerminal'), ownerDocument);
        return;
      }
      const snapshot = pane.getSnapshot();
      if (snapshot.isDead) {
        showToast(t('fileDrop.terminalEnded'), ownerDocument);
        return;
      }
      if (snapshot.activePty) {
        if (!snapshot.sessionId || !agentSessionsRef.current.has(snapshot.sessionId)) {
          showToast(t('fileDrop.nonAgentDisabled'), ownerDocument);
          return;
        }
        const result = pane.pasteToPty(unique.map(quotePtyPath).join(' '));
        if (!result.ok) showToast(t('fileDrop.agentPasteFailed'), ownerDocument);
        return;
      }
      if (snapshot.isBusy) {
        showToast(t('fileDrop.waitForCommand'), ownerDocument);
        return;
      }
      const result = pane.insertText(unique.map(quoteEzArgument).join(' '));
      if (!result.ok) showToast(t('fileDrop.insertFailed'), ownerDocument);
    };

    const removers = [
      addAppWindowEventListener('dragenter', onDragEnter as EventListener, true),
      addAppWindowEventListener('dragover', onDragOver as EventListener, true),
      addAppWindowEventListener('dragleave', onDragLeave as EventListener, true),
      addAppWindowEventListener('drop', onDrop as EventListener, true),
      addAppWindowEventListener('unload', (() => setDragTarget(null)) as EventListener),
    ];
    return () => {
      for (const remove of removers) remove();
    };
  }, [capabilities, maxDroppedPaths, t]);

  if (!dragTarget || dragTarget.ownerDocument.defaultView?.closed) return null;
  return createPortal((
    <div className="file-drop-overlay" aria-hidden="true" data-testid="file-drop-overlay">
      <span>{t('fileDrop.prompt')}</span>
      <small>{t('fileDrop.safety')}</small>
    </div>
  ), dragTarget.ownerDocument.body);
}
