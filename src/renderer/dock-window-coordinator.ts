import type {
  AddPanelOptions,
  DockviewApi,
  IDockviewPanel,
} from 'dockview-react';

import { isDetachableDockPanelComponent } from '../shared/dock-panel-capabilities';
import { auxiliaryPopoutUrl } from './dockview-popouts';
import {
  findMainGridPanel,
  movePanelToMainGrid,
} from './main-window-panel-routing';

export type DockSplitDirection = 'right' | 'below';

export type DockPanelPlacementIntent =
  | { readonly kind: 'main-tab' }
  | {
      readonly kind: 'split';
      readonly referencePanelId: string;
      readonly direction: DockSplitDirection;
    };

type DockPanelOptions = Omit<AddPanelOptions, 'position' | 'floating'>;

function panelWindow(panel: IDockviewPanel): Window | null {
  try {
    const target = panel.api.getWindow();
    return target.closed ? null : target;
  } catch {
    return null;
  }
}

/**
 * Owns native-window-aware Dockview placement. Callers state an intent; they
 * never infer a target from Dockview's process-global active group.
 */
export class DockWindowCoordinator {
  private readonly activePanelByWindow = new Map<Window, string>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private lastMainPanelId: string | null = null;
  private disposed = false;

  public constructor(private readonly api: DockviewApi) {
    for (const panel of api.panels) {
      if (panel.api.location.type === 'grid' && !this.lastMainPanelId) {
        this.lastMainPanelId = panel.id;
      }
      if (panel.group.activePanel === panel) this.rememberPanel(panel);
    }
    if (api.activePanel) this.rememberPanel(api.activePanel);
    this.disposables.push(
      api.onDidActivePanelChange((event) => {
        if (event.panel) this.rememberPanel(event.panel);
      }),
      api.onDidMovePanel(({ panel }) => this.rememberPanel(panel)),
      api.onDidRemovePanel((panel) => this.forgetPanel(panel.id)),
    );
  }

  public addPanel(
    options: DockPanelOptions,
    placement: DockPanelPlacementIntent,
  ): IDockviewPanel {
    if (this.disposed) throw new Error('DockWindowCoordinator is disposed');
    if (placement.kind === 'main-tab') {
      const reference = this.mainReferencePanel();
      const panel = this.api.addPanel({
        ...options,
        position: reference
          ? { referencePanel: reference, direction: 'within' }
          : { direction: 'right' },
      });
      this.rememberPanel(panel);
      return panel;
    }

    const reference = this.api.getPanel(placement.referencePanelId);
    if (!reference) {
      throw new Error(`Dockview reference panel '${placement.referencePanelId}' does not exist`);
    }
    if (reference.api.location.type === 'grid') {
      const panel = this.api.addPanel({
        ...options,
        position: {
          referencePanel: reference,
          direction: placement.direction,
        },
      });
      this.rememberPanel(panel);
      return panel;
    }

    // Dockview's addPanel(relative direction) resolves against the main grid.
    // For a nested popout grid, first add a tab to the exact group and then
    // use the move engine, which resolves the destination group's real grid.
    const panel = this.api.addPanel({
      ...options,
      position: { referencePanel: reference, direction: 'within' },
    });
    panel.api.moveTo({
      group: reference.group,
      position: placement.direction === 'below' ? 'bottom' : 'right',
    });
    this.rememberPanel(panel);
    return panel;
  }

  public activePanelIdForDocument(ownerDocument: Document): string | null {
    const targetWindow = ownerDocument.defaultView;
    if (!targetWindow || targetWindow.closed) return null;
    const rememberedId = this.activePanelByWindow.get(targetWindow);
    const remembered = rememberedId ? this.api.getPanel(rememberedId) : undefined;
    if (remembered && panelWindow(remembered) === targetWindow) return remembered.id;

    const candidate = this.api.panels.find((panel) => (
      panelWindow(panel) === targetWindow && panel.group.activePanel === panel
    )) ?? this.api.panels.find((panel) => panelWindow(panel) === targetWindow);
    if (!candidate) return null;
    this.activePanelByWindow.set(targetWindow, candidate.id);
    return candidate.id;
  }

  public focusPanelWindow(panel: IDockviewPanel): void {
    const target = panelWindow(panel);
    if (!target) return;
    target.focus();
    this.rememberPanel(panel);
  }

  /** Move one detachable tab into its own native auxiliary window. */
  public async movePanelToNewWindow(panelId: string): Promise<boolean> {
    if (this.disposed) return false;
    const panel = this.api.getPanel(panelId);
    if (!panel || !isDetachableDockPanelComponent(panel.api.component)) return false;
    if (panel.api.location.type === 'popout' && panel.group.panels.length === 1) return false;
    const opened = await this.api.addPopoutGroup(panel, {
      popoutUrl: auxiliaryPopoutUrl(),
    });
    return Boolean(opened);
  }

  /** Recover a detached tab into the stable main-grid anchor. */
  public movePanelToMainWindow(panelId: string): boolean {
    if (this.disposed) return false;
    const panel = this.api.getPanel(panelId);
    if (!panel || panel.api.location.type === 'grid') return false;
    const mainReference = this.mainReferencePanel();
    const mainWindow = mainReference ? panelWindow(mainReference) : window;
    movePanelToMainGrid(this.api, panel, mainReference);
    panel.api.setActive();
    mainWindow?.focus();
    this.rememberPanel(panel);
    return true;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.activePanelByWindow.clear();
  }

  private mainReferencePanel(): IDockviewPanel | undefined {
    const preferred = this.lastMainPanelId
      ? this.api.getPanel(this.lastMainPanelId)
      : undefined;
    const panel = findMainGridPanel(this.api, preferred);
    if (panel) this.lastMainPanelId = panel.id;
    return panel;
  }

  private rememberPanel(panel: IDockviewPanel): void {
    const target = panelWindow(panel);
    if (target) this.activePanelByWindow.set(target, panel.id);
    if (panel.api.location.type === 'grid') this.lastMainPanelId = panel.id;
  }

  private forgetPanel(panelId: string): void {
    for (const [target, rememberedId] of this.activePanelByWindow) {
      if (rememberedId === panelId) this.activePanelByWindow.delete(target);
    }
    if (this.lastMainPanelId === panelId) this.lastMainPanelId = null;
  }
}
