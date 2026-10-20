import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';

import type { DockWindowCoordinator } from '../dock-window-coordinator';
import { markResultsAutoOpened, markResultsDismissed, readResultsTabPrefs } from './results-prefs';
import { readResultsSource, requestResultsNavigation, retractResultsSource, type ResultsNavigation } from './results-source-store';

export const AGENT_RESULTS_COMPONENT = 'agent-results';
const CONVERSATION_COMPONENT = 'agent-session';

/** Content width (at 100% UI scale) a conversation group needs before Results sits beside it. */
const SPLIT_MIN_CONTENT_WIDTH = 840;
const RESULTS_MIN_CONTENT_WIDTH = 340;
const RESULTS_MAX_CONTENT_WIDTH = 640;
const RESULTS_SHARE = 0.42;

export function resultsPanelId(ownerPanelId: string): string {
  return `agent-results-${ownerPanelId}`;
}

export interface AgentResultsOpenRequest {
  /** Bring the tab forward and focus it (a person asked); otherwise show it without taking focus. */
  readonly activate?: boolean;
  readonly target?: Omit<ResultsNavigation, 'sequence'>;
}

export interface AgentResultsDockOptions {
  /** A layout restore or replacement is running: closes then are not the person's choice. */
  readonly isLayoutTransactionActive: () => boolean;
  /** Current product UI scale multiplier (1 = 100%). */
  readonly uiScale?: () => number;
  readonly title?: (ownerPanelId: string) => string;
}

function sameWindow(left: IDockviewPanel, right: IDockviewPanel): boolean {
  try {
    return left.api.getWindow() === right.api.getWindow();
  } catch {
    return false;
  }
}

function resultsOnly(group: DockviewGroupPanel): boolean {
  return group.panels.length > 0 && group.panels.every((panel) => panel.api.component === AGENT_RESULTS_COMPONENT);
}

/**
 * Places each conversation's Results tab beside it, shows the active
 * conversation's tab, closes it with its conversation, and remembers when the
 * person closed it. Showing a tab never moves keyboard focus unless the person
 * asked for it.
 */
export class AgentResultsDock {
  private readonly disposables: { dispose(): void }[] = [];
  private readonly programmaticClose = new Set<string>();
  /** Conversations with a result waiting to open once they are in view. */
  private readonly pendingAuto = new Set<string>();
  private disposed = false;

  public constructor(
    private readonly api: DockviewApi,
    private readonly dockWindows: DockWindowCoordinator,
    private readonly options: AgentResultsDockOptions,
  ) {
    this.disposables.push(
      api.onDidRemovePanel((panel) => this.onRemoved(panel)),
      api.onDidActivePanelChange((event) => { if (event.panel) this.onActive(event.panel); }),
    );
  }

  public isOpen(ownerPanelId: string): boolean {
    return Boolean(this.api.getPanel(resultsPanelId(ownerPanelId)));
  }

  public open(ownerPanelId: string, request: AgentResultsOpenRequest = {}): boolean {
    if (this.disposed) return false;
    const owner = this.api.getPanel(ownerPanelId);
    if (!owner || owner.api.component !== CONVERSATION_COMPONENT) return false;
    if (request.target) requestResultsNavigation(ownerPanelId, request.target);
    const existing = this.api.getPanel(resultsPanelId(ownerPanelId));
    if (existing) {
      if (request.activate) this.activate(existing);
      else this.reveal(existing, owner);
      return true;
    }
    this.keepingFocus(!request.activate, () => {
      const panel = this.add(owner, Boolean(request.activate));
      if (request.activate) this.activate(panel);
      else this.reveal(panel, owner);
    });
    return true;
  }

  /**
   * A result arrived in a conversation. Opens its tab once, beside it, if the
   * person never closed it and the conversation is in view; otherwise waits.
   */
  public requestAutoOpen(ownerPanelId: string, sessionId: string): void {
    if (this.disposed || this.options.isLayoutTransactionActive()) return;
    const prefs = readResultsTabPrefs(sessionId);
    if (prefs.dismissed || prefs.autoOpened || this.isOpen(ownerPanelId)) return;
    const owner = this.api.getPanel(ownerPanelId);
    if (!owner) return;
    if (!owner.api.isVisible || owner.group.activePanel !== owner) {
      this.pendingAuto.add(ownerPanelId);
      return;
    }
    this.pendingAuto.delete(ownerPanelId);
    if (this.open(ownerPanelId)) markResultsAutoOpened(sessionId);
  }

  public close(ownerPanelId: string): void {
    const panel = this.api.getPanel(resultsPanelId(ownerPanelId));
    if (!panel) return;
    this.programmaticClose.add(panel.id);
    panel.api.close();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.pendingAuto.clear();
  }

  private scale(): number {
    const value = this.options.uiScale?.() ?? 1;
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  private add(owner: IDockviewPanel, activate: boolean): IDockviewPanel {
    const options = {
      id: resultsPanelId(owner.id),
      component: AGENT_RESULTS_COMPONENT,
      title: this.options.title?.(owner.id) ?? 'Results',
      params: { ownerPanelId: owner.id },
      renderer: 'always' as const,
      inactive: !activate,
    };
    const shared = this.api.groups.find((group) => group !== owner.group && resultsOnly(group)
      && group.api.isVisible && group.panels[0] !== undefined && sameWindow(group.panels[0], owner));
    if (shared) {
      return this.api.addPanel({ ...options, position: { referenceGroup: shared, direction: 'within' } });
    }
    const scale = this.scale();
    const width = owner.group.width;
    if (width >= SPLIT_MIN_CONTENT_WIDTH * scale) {
      const initialWidth = Math.round(Math.min(RESULTS_MAX_CONTENT_WIDTH * scale, Math.max(RESULTS_MIN_CONTENT_WIDTH * scale, width * RESULTS_SHARE)));
      return this.dockWindows.addPanel({ ...options, initialWidth }, { kind: 'split', referencePanelId: owner.id, direction: 'right' });
    }
    // Too narrow to sit side by side: a tab next to the conversation, switched to on demand.
    return this.api.addPanel({ ...options, position: { referencePanel: owner, direction: 'within' } });
  }

  private activate(panel: IDockviewPanel): void {
    panel.api.setActive();
    this.dockWindows.focusPanelWindow(panel);
  }

  /** Shows the tab in its own group without making that group active; never covers the conversation. */
  private reveal(panel: IDockviewPanel, owner: IDockviewPanel): void {
    if (panel.group === owner.group || panel.group.activePanel === panel) return;
    panel.group.model.openPanel(panel, { skipSetGroupActive: true });
  }

  /** Runs a layout change and puts keyboard focus back where the person left it. */
  private keepingFocus(keep: boolean, change: () => void): void {
    const focused = keep && typeof document !== 'undefined' ? document.activeElement : null;
    change();
    if (!keep || !(focused instanceof HTMLElement) || !focused.isConnected || document.activeElement === focused) return;
    try { focused.focus({ preventScroll: true }); } catch { focused.focus(); }
  }

  private onActive(panel: IDockviewPanel): void {
    if (panel.api.component !== CONVERSATION_COMPONENT) return;
    const results = this.api.getPanel(resultsPanelId(panel.id));
    if (results) {
      this.reveal(results, panel);
      return;
    }
    if (this.pendingAuto.has(panel.id)) {
      const sessionId = readResultsSource(panel.id)?.sessionId;
      this.pendingAuto.delete(panel.id);
      if (sessionId) queueMicrotask(() => this.requestAutoOpen(panel.id, sessionId));
    }
  }

  private onRemoved(panel: IDockviewPanel): void {
    if (this.disposed) return;
    const component = panel.api.component;
    if (component === CONVERSATION_COMPONENT) {
      this.pendingAuto.delete(panel.id);
      const results = this.api.getPanel(resultsPanelId(panel.id));
      if (results) {
        this.programmaticClose.add(results.id);
        // Closing inside Dockview's own remove event would re-enter it.
        queueMicrotask(() => { if (this.api.getPanel(results.id)) results.api.close(); else this.programmaticClose.delete(results.id); });
      }
      retractResultsSource(panel.id);
      return;
    }
    if (component !== AGENT_RESULTS_COMPONENT) return;
    if (this.programmaticClose.delete(panel.id) || this.options.isLayoutTransactionActive()) return;
    const ownerPanelId = (panel.params as { ownerPanelId?: unknown } | undefined)?.ownerPanelId;
    if (typeof ownerPanelId !== 'string' || !this.api.getPanel(ownerPanelId)) return;
    const sessionId = readResultsSource(ownerPanelId)?.sessionId;
    if (sessionId) markResultsDismissed(sessionId);
  }
}
