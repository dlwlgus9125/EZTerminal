import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { WorkbenchViewsSchema, type WorkbenchViewsState, type WorkbenchView } from '../shared/workbench-views';

const controllers = new WeakMap<DockviewApi, WorkbenchViewsController>();
export function serializeWorkbench(api: DockviewApi): ReturnType<DockviewApi['toJSON']> & { workbenchViews?: WorkbenchViewsState } {
  return { ...api.toJSON(), ...(controllers.has(api) ? { workbenchViews: controllers.get(api)!.serialize() } : {}) };
}
export function restoreWorkbench(api: DockviewApi, layout: Parameters<DockviewApi['fromJSON']>[0]): void {
  const controller = controllers.get(api);
  if (controller) controller.restore(layout, () => api.fromJSON(layout));
  else api.fromJSON(layout);
}

/** One Dockview, durable panel instances. Inactive view groups are hidden, never disposed. */
export class WorkbenchViewsController {
  private state: WorkbenchViewsState = { version: 1, activeId: 'main', views: [{ id: 'main', title: '', panelIds: [] }] };
  private listeners = new Set<() => void>();
  private disposables: { dispose(): void }[] = [];
  private applying = false;
  private narrow = false;
  private focused = false;
  private observer?: ResizeObserver;
  constructor(readonly api: DockviewApi, private readonly changed: () => void) {
    controllers.set(api, this);
    this.disposables.push(api.onDidAddPanel(panel => {
      if (this.applying) return;
      this.adopt(panel); this.apply(); this.emit();
    }), api.onDidRemovePanel(() => {
      if (this.applying) return;
      this.prune(); this.emit();
    }), api.onDidActivePanelChange(event => {
      if (this.applying || !event.panel) return;
      const view = this.owner(event.panel.id);
      if (!view) return;
      view.activePanelId = event.panel.id;
      if (event.panel.api.location.type === 'grid') this.state.activeId = view.id;
      this.apply(); this.emit();
    }), api.onDidMovePanel(event => {
      if (this.applying) return;
      const neighbour = event.panel.group.panels.find(panel => panel.id !== event.panel.id);
      const target = neighbour && this.owner(neighbour.id);
      if (target) this.assign(event.panel.id, target.id);
      this.apply(); this.emit();
    }));
  }
  get views(): readonly WorkbenchView[] { return this.state.views; }
  get activeId(): string { return this.state.activeId; }
  get isFocused(): boolean { return this.focused; }
  get isNarrow(): boolean { return this.narrow; }
  get panels(): readonly IDockviewPanel[] { return this.api.panels.filter(panel => this.owner(panel.id)?.id === this.activeId && panel.api.location.type === 'grid'); }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private owner(panelId: string): WorkbenchView | undefined { return this.state.views.find(view => view.panelIds.includes(panelId)); }
  private assign(panelId: string, viewId: string): void {
    for (const view of this.state.views) view.panelIds = view.panelIds.filter(id => id !== panelId);
    this.state.views.find(view => view.id === viewId)!.panelIds.push(panelId);
  }
  private adopt(panel: IDockviewPanel): void {
    if (!this.owner(panel.id)) this.assign(panel.id, this.activeId);
  }
  private prune(): void {
    const available = new Set(this.api.panels.map(panel => panel.id));
    for (const view of this.state.views) view.panelIds = view.panelIds.filter(id => available.has(id));
    for (const panel of this.api.panels) this.adopt(panel);
  }
  private emit(): void { for (const listener of this.listeners) listener(); this.changed(); }
  private apply(): void {
    if (this.applying) return;
    this.applying = true;
    try {
      if (this.api.hasMaximizedGroup()) this.api.exitMaximizedGroup();
      for (const group of this.api.groups) {
        if (group.api.location.type !== 'grid') continue;
        const belongs = group.panels.some(panel => this.owner(panel.id)?.id === this.activeId);
        group.api.setVisible(belongs);
      }
      const view = this.state.views.find(item => item.id === this.activeId)!;
      const panel = this.panels.find(item => item.id === view.activePanelId) ?? this.panels[0];
      if (panel) {
        panel.api.setActive();
        if (this.narrow || this.focused) this.api.maximizeGroup(panel);
      }
    } finally { this.applying = false; }
  }
  activate(id: string): void {
    if (!this.state.views.some(view => view.id === id)) return;
    this.state.activeId = id; this.apply(); this.emit();
  }
  create(title: string): void {
    if (this.views.length >= 32) return;
    const id = crypto.randomUUID();
    this.state.views.push({ id, title: title.slice(0, 80), panelIds: [] });
    this.activate(id);
  }
  rename(id: string, title: string): void {
    const view = this.state.views.find(item => item.id === id);
    if (!view || !title.trim()) return;
    view.title = title.trim().slice(0, 80); this.emit();
  }
  close(id: string): void {
    if (this.views.length === 1) return;
    const view = this.state.views.find(item => item.id === id);
    const target = this.state.views.find(item => item.id !== id);
    if (!view || !target) return;
    target.panelIds.push(...view.panelIds);
    this.state.views = this.state.views.filter(item => item.id !== id);
    this.activate(target.id);
  }
  move(panelId: string, viewId: string): void {
    const panel = this.api.getPanel(panelId);
    if (!panel || !this.state.views.some(view => view.id === viewId)) return;
    this.applying = true;
    try {
      const reference = this.api.panels.find(item => item.id !== panelId && this.owner(item.id)?.id === viewId && item.api.location.type === 'grid');
      const group = reference?.group ?? this.api.addGroup({ direction: 'right' });
      panel.api.moveTo({ group, position: 'center', skipSetActive: true });
      this.assign(panelId, viewId);
    } finally { this.applying = false; }
    this.activate(viewId);
  }
  toggleFocus(): void { this.focused = !this.focused; this.apply(); this.emit(); }
  observe(element: HTMLElement): void {
    const measure = (): void => {
      const next = element.clientWidth < 600 || element.clientHeight < 265;
      if (this.narrow !== next) { this.narrow = next; this.apply(); this.emit(); }
    };
    measure();
    this.observer = new ResizeObserver(measure); this.observer.observe(element);
  }
  serialize(): WorkbenchViewsState { this.prune(); return structuredClone(this.state); }
  restore(layout: unknown, restore: () => void): void {
    this.applying = true;
    try {
      const parsed = WorkbenchViewsSchema.safeParse((layout as { workbenchViews?: unknown })?.workbenchViews);
      this.state = parsed.success ? parsed.data : { version: 1, activeId: 'main', views: [{ id: 'main', title: '', panelIds: [] }] };
      restore(); this.prune();
    } finally { this.applying = false; }
    this.apply(); this.emit();
  }
  dispose(): void {
    this.observer?.disconnect(); this.disposables.forEach(disposable => disposable.dispose());
    this.listeners.clear(); controllers.delete(this.api);
  }
}
