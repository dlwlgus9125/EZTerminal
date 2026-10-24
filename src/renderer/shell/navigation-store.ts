/**
 * Where the Board + Desk shell is: the project board, or work mode (live list
 * + dock), and which project the top bar has selected.
 *
 * Rules (approved shell, 2026-10-24):
 * - The project follows the active main-window tab: a conversation or terminal
 *   of another project switches it; a tab without a project (plain terminal,
 *   OpenClaw) leaves it as it is.
 * - Picking a project tab shows that project's board; opening anything from a
 *   board, list or card enters work mode.
 * - The state is per window and per device: it is kept in renderer session
 *   view state, not in the saved layout, so the layout schema stays as it is.
 */
export type ShellMode = 'board' | 'work';

export interface ShellNavigationState {
  readonly mode: ShellMode;
  readonly projectId: string | null;
}

export const INITIAL_SHELL_NAVIGATION: ShellNavigationState = { mode: 'board', projectId: null };

export class ShellNavigation {
  private state: ShellNavigationState;
  private readonly listeners = new Set<() => void>();

  public constructor(
    initial: ShellNavigationState = INITIAL_SHELL_NAVIGATION,
    private readonly persist?: (state: ShellNavigationState) => void,
  ) {
    this.state = initial;
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  public readonly getSnapshot = (): ShellNavigationState => this.state;

  /** A project tab, or the board button: that project's board. */
  public showBoard(projectId: string | null = this.state.projectId): void {
    this.set({ mode: 'board', projectId });
  }

  /** Something was opened to work on (a conversation, a terminal, a flow). */
  public showWork(projectId?: string | null): void {
    this.set({ mode: 'work', projectId: projectId === undefined || projectId === null ? this.state.projectId : projectId });
  }

  /** The active main-window tab changed; a tab without a project keeps the current one. */
  public followPanel(projectId: string | undefined): void {
    if (!projectId || projectId === this.state.projectId) return;
    this.set({ ...this.state, projectId });
  }

  /** The selected project went away (removed or archived). */
  public forgetProject(projectId: string): void {
    if (this.state.projectId === projectId) this.set({ ...this.state, projectId: null });
  }

  private set(next: ShellNavigationState): void {
    if (next.mode === this.state.mode && next.projectId === this.state.projectId) return;
    this.state = next;
    this.persist?.(next);
    for (const listener of [...this.listeners]) listener();
  }
}

export function parseShellNavigation(value: unknown): ShellNavigationState {
  if (!value || typeof value !== 'object') return INITIAL_SHELL_NAVIGATION;
  const record = value as Record<string, unknown>;
  return {
    mode: record.mode === 'work' ? 'work' : 'board',
    projectId: typeof record.projectId === 'string' && record.projectId ? record.projectId : null,
  };
}

export interface ProjectTabCandidate {
  readonly projectId: string;
  readonly name: string;
  readonly pinned: boolean;
  readonly lastActiveAt?: string | number;
}

/**
 * The project tabs in the top bar: pinned projects, then the most recently
 * active, up to `limit`; the selected project always has a tab. The rest are
 * reached through the project picker.
 */
export function projectTabs(
  projects: readonly ProjectTabCandidate[],
  selectedId: string | null,
  limit = 5,
): ProjectTabCandidate[] {
  const recency = (project: ProjectTabCandidate): number => {
    const value = project.lastActiveAt;
    if (typeof value === 'number') return value;
    return value ? Date.parse(value) || 0 : 0;
  };
  const ordered = [...projects].sort((left, right) => (Number(right.pinned) - Number(left.pinned)) || (recency(right) - recency(left)));
  const tabs = ordered.slice(0, limit);
  const selected = selectedId ? projects.find((project) => project.projectId === selectedId) : undefined;
  if (selected && !tabs.includes(selected)) tabs[tabs.length - 1] = selected;
  return tabs;
}
