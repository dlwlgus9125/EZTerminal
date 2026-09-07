import { useCallback, useEffect, useRef } from 'react';

import { type DockviewApi, type IDockviewPanel } from 'dockview-react';

import {
  projectEditorDocumentParametersEqual,
  projectEditorDocumentPathKey,
  projectEditorDocumentsEqual,
  projectEditorTitle,
  type ProjectEditorDocument,
} from './project-editor-model';

import {
  flushProjectCodeFocus,
  requestProjectCodeFocus,
  requestProjectCodeReveal,
  type ProjectCodeLocation,
} from './project-code-navigation';

import {
  applyProjectReviewLayout,
  captureProjectReviewLayout,
  restoreProjectReviewLayout,
  type ProjectReviewLayoutSnapshot,
} from './project-review-layout';

import { SessionMirroringCoordinator } from './session-mirroring-coordinator';

import { type SidebarDestination } from './workbench';

import { type WorkbenchPanelPlacement } from './workbench-coordinator';
import { DockWindowCoordinator } from './dock-window-coordinator';

import { findMainGridPanel } from './main-window-panel-routing';

import type { TFunction } from 'i18next';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';

interface UseProjectDocumentNavigationOptions {
  readonly apiRef: MutableRefObject<DockviewApi | null>;
  readonly projectDrillActive: boolean;
  readonly projectReviewLayoutRef: MutableRefObject<ProjectReviewLayoutSnapshot | null>;
  readonly projectWide: boolean;
  readonly sessionMirroringCoordinator: SessionMirroringCoordinator;
  readonly lastMainGridPanelRef: MutableRefObject<IDockviewPanel | null>;
  readonly dockWindowCoordinatorRef: MutableRefObject<DockWindowCoordinator | null>;
  readonly setSidebarDestination: Dispatch<SetStateAction<SidebarDestination | null>>;
  readonly t: TFunction<"translation", undefined>;
}

export function useProjectDocumentNavigation({

  apiRef,

  projectDrillActive,

  projectReviewLayoutRef,

  projectWide,

  sessionMirroringCoordinator,

  lastMainGridPanelRef,

  dockWindowCoordinatorRef,

  setSidebarDestination,

  t,

}: UseProjectDocumentNavigationOptions) {
  const codePanelSequence = useRef(0);
  const projectMapPanelSequence = useRef(0);
  const projectDocumentNavigationSequence = useRef(0);
  const projectDocumentNavigation = useRef(new Map<string, number>());

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (projectDrillActive) {
      projectReviewLayoutRef.current ??= captureProjectReviewLayout(api);
      const editor = api.activePanel?.api.component === 'project-editor'
        ? api.activePanel
        : api.panels.find((panel) => panel.api.component === 'project-editor');
      if (editor) applyProjectReviewLayout(api, editor, projectWide ? 'wide' : 'narrow');
      return;
    }
    const snapshot = projectReviewLayoutRef.current;
    projectReviewLayoutRef.current = null;
    if (snapshot) restoreProjectReviewLayout(api, snapshot);
  }, [apiRef, projectDrillActive, projectReviewLayoutRef, projectWide]);

  const commitProjectDocument = useCallback((
    document: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ): void => {
    if (sessionMirroringCoordinator.getSnapshot().replacementLocked) return;
    const api = apiRef.current;
    if (!api) return;
    requestProjectCodeReveal(document, location);
    const shouldFocusEditor = !projectDrillActive || !projectWide;
    if (shouldFocusEditor) requestProjectCodeFocus(document);
    const editorPanels = api.panels.filter((panel) => panel.api.component === 'project-editor');
    let matchingDocument: ProjectEditorDocument | undefined;
    const matching = editorPanels.find((panel) => {
      const params = panel.api.getParameters<ProjectEditorDocument>();
      if (!projectEditorDocumentsEqual(params, document)) return false;
      matchingDocument = params;
      return true;
    });
    const mainReference = findMainGridPanel(api, lastMainGridPanelRef.current);
    const previousActive = mainReference;
    let panel = matching;
    if (panel) {
      if (!matchingDocument
        || !projectEditorDocumentParametersEqual(matchingDocument, document)) {
        panel.api.updateParameters(document);
      }
      panel.api.setTitle(projectEditorTitle(document));
    } else {
      codePanelSequence.current += 1;
      const active = findMainGridPanel(api, lastMainGridPanelRef.current);
      const placement: WorkbenchPanelPlacement = active
        && !projectDrillActive
        && window.innerWidth >= 1200
        ? { kind: 'split', referencePanelId: active.id, direction: 'right' }
        : { kind: 'main-tab' };
      panel = dockWindowCoordinatorRef.current?.addPanel({
        id: `project-editor-${Date.now().toString(36)}-${String(codePanelSequence.current)}`,
        component: 'project-editor',
        title: projectEditorTitle(document),
        renderer: 'onlyWhenVisible',
        params: document,
        inactive: projectDrillActive && projectWide,
      }, placement);
      if (!panel) return;
      // Dockview passes initial params to the renderer but leaves the panel
      // API parameter store empty until the first explicit update.
      panel.api.updateParameters(document);
    }
    if (projectDrillActive) {
      projectReviewLayoutRef.current ??= captureProjectReviewLayout(api);
      applyProjectReviewLayout(api, panel, projectWide ? 'wide' : 'narrow');
      panel.api.setActive();
      dockWindowCoordinatorRef.current?.focusPanelWindow(panel);
      if (projectWide && previousActive?.api.component !== 'project-editor') {
        previousActive?.api.setActive();
      }
      if (!projectWide) {
        setSidebarDestination(null);
        requestAnimationFrame(() => {
          if (api.activePanel?.id === panel.id) flushProjectCodeFocus(document);
        });
      }
    } else {
      panel.api.setActive();
      dockWindowCoordinatorRef.current?.focusPanelWindow(panel);
      requestAnimationFrame(() => {
        if (api.activePanel?.id === panel.id) flushProjectCodeFocus(document);
      });
    }
  }, [apiRef, dockWindowCoordinatorRef, lastMainGridPanelRef, projectDrillActive, projectReviewLayoutRef, projectWide, sessionMirroringCoordinator, setSidebarDestination]);

  const openProjectDocument = useCallback((
    requested: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ): void => {
    projectDocumentNavigationSequence.current += 1;
    const navigation = projectDocumentNavigationSequence.current;
    const requestKey = projectEditorDocumentPathKey(requested);
    projectDocumentNavigation.current.set(requestKey, navigation);
    if (requested.documentKey) {
      commitProjectDocument({
        ...requested,
        lens: requested.lens ?? { kind: 'current' },
      }, location);
      return;
    }
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    void desktop.resolveProjectDocument({
      kind: 'project-path',
      projectId: requested.projectId,
      rootId: requested.rootId,
      workspaceId: requested.workspaceId,
      relativePath: requested.relativePath,
      lens: requested.lens ?? { kind: 'current' },
      ...(location?.line ? { line: location.line } : {}),
      ...(location?.column ? { column: location.column } : {}),
    }).then((result) => {
      if (projectDocumentNavigation.current.get(requestKey) !== navigation) return;
      if (!result.ok) return;
      commitProjectDocument({
        ...result.target.document.id,
        documentKey: result.target.document.key,
        lens: result.target.lens,
      }, result.target.line
        ? {
          line: result.target.line,
          ...(result.target.column ? { column: result.target.column } : {}),
        }
        : undefined);
    }).catch(() => undefined);
  }, [commitProjectDocument]);

  const openProjectFile = useCallback((
    projectId: string,
    rootId: string,
    relativePath: string,
    location?: ProjectCodeLocation,
    workspaceId = rootId,
  ): void => {
    openProjectDocument({ projectId, rootId, workspaceId, relativePath }, location);
  }, [openProjectDocument]);

  const openProjectMap = useCallback((target: {
    readonly projectId: string;
    readonly rootId: string;
    readonly workspaceId: string;
  }): void => {
    if (sessionMirroringCoordinator.getSnapshot().replacementLocked) return;
    const api = apiRef.current;
    if (!api) return;
    const params = {
      projectId: target.projectId,
      ownerRootId: target.rootId,
      ownerWorkspaceId: target.workspaceId,
    };
    let panel = api.panels.find((candidate) => {
      if (candidate.api.component !== 'project-map') return false;
      const current = candidate.api.getParameters<typeof params>();
      return current?.projectId === params.projectId
        && current.ownerRootId === params.ownerRootId
        && current.ownerWorkspaceId === params.ownerWorkspaceId;
    });
    if (!panel) {
      projectMapPanelSequence.current += 1;
      panel = dockWindowCoordinatorRef.current?.addPanel({
        id: `project-map-${Date.now().toString(36)}-${String(projectMapPanelSequence.current)}`,
        component: 'project-map',
        title: t('projectMap.title', 'Project Map'),
        renderer: 'onlyWhenVisible',
        params,
      }, { kind: 'main-tab' });
      panel?.api.updateParameters(params);
    }
    panel?.api.setActive();
    if (panel) dockWindowCoordinatorRef.current?.focusPanelWindow(panel);
  }, [apiRef, dockWindowCoordinatorRef, sessionMirroringCoordinator, t]);

  return { openProjectDocument, openProjectFile, openProjectMap };
}
