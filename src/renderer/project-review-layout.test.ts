import type { DockviewApi, DockviewGroupPanel, DockviewPanelApi, IDockviewPanel } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyProjectReviewLayout,
  captureProjectReviewLayout,
  restoreProjectReviewLayout,
} from './project-review-layout';

interface FakeGroup {
  readonly id: string;
  readonly panels: IDockviewPanel[];
  readonly element: { getBoundingClientRect: () => DOMRect };
  readonly api: {
    readonly setSize: ReturnType<typeof vi.fn>;
    readonly isMaximized: ReturnType<typeof vi.fn>;
    readonly maximize: ReturnType<typeof vi.fn>;
  };
  readonly width: number;
  readonly height: number;
  activePanel?: IDockviewPanel;
}

interface FakePanel {
  readonly panel: IDockviewPanel;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly setActive: ReturnType<typeof vi.fn>;
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x, toJSON: () => ({}) };
}

function fakeWorkbench(): {
  readonly api: DockviewApi;
  readonly groups: FakeGroup[];
  readonly addGroup: (id: string, x: number, y: number, width: number, height: number) => FakeGroup;
  readonly addPanel: (id: string, component: string, group: FakeGroup) => FakePanel;
  readonly active: { panel?: IDockviewPanel };
  readonly maximized: { group?: FakeGroup };
} {
  const groups: FakeGroup[] = [];
  const panels: IDockviewPanel[] = [];
  const active: { panel?: IDockviewPanel } = {};
  const maximized: { group?: FakeGroup } = {};
  let splitSequence = 0;

  const addGroup = (id: string, x: number, y: number, width: number, height: number): FakeGroup => {
    const group: FakeGroup = {
      id,
      panels: [],
      element: { getBoundingClientRect: () => rect(x, y, width, height) },
      api: {
        setSize: vi.fn(),
        isMaximized: vi.fn(() => maximized.group === group),
        maximize: vi.fn(() => {
          maximized.group = group;
          active.panel = group.activePanel;
        }),
      },
      width,
      height,
    };
    groups.push(group);
    return group;
  };

  const addPanel = (id: string, component: string, initialGroup: FakeGroup): FakePanel => {
    let group = initialGroup;
    const setActive = vi.fn(() => {
      group.activePanel = panel;
      active.panel = panel;
    });
    const moveTo = vi.fn((target: {
      group: FakeGroup;
      position: string;
      skipSetActive?: boolean;
    }) => {
      const previousGroup = group;
      const previousIndex = previousGroup.panels.indexOf(panel);
      if (previousIndex >= 0) previousGroup.panels.splice(previousIndex, 1);
      if (previousGroup.activePanel === panel) previousGroup.activePanel = previousGroup.panels[0];
      if (previousGroup.panels.length === 0) {
        const groupIndex = groups.indexOf(previousGroup);
        if (groupIndex >= 0) groups.splice(groupIndex, 1);
      }
      if (target.position === 'center') {
        group = target.group;
      } else {
        splitSequence += 1;
        group = addGroup(`${id}-${target.position}-${String(splitSequence)}`, 0, 0, 400, 300);
      }
      group.panels.push(panel);
      group.activePanel ??= panel;
      if (!target.skipSetActive) setActive();
    });
    const panelApi = {
      get group() { return group as unknown as DockviewGroupPanel; },
      location: { type: 'grid' },
      component,
      moveTo,
      setActive,
    } as unknown as DockviewPanelApi;
    const panel = { id, api: panelApi } as unknown as IDockviewPanel;
    initialGroup.panels.push(panel);
    initialGroup.activePanel ??= panel;
    panels.push(panel);
    return { panel, moveTo, setActive };
  };

  const api = {
    panels,
    get groups() { return groups as unknown as readonly DockviewGroupPanel[]; },
    get activePanel() { return active.panel; },
    get activeGroup() { return active.panel?.api.group; },
    height: 900,
    addGroup: vi.fn(() => addGroup(`absolute-${String(++splitSequence)}`, 0, 0, 1000, 600)),
    maximizeGroup: vi.fn((panel: IDockviewPanel) => {
      maximized.group = panel.api.group as unknown as FakeGroup;
      active.panel = maximized.group.activePanel ?? panel;
    }),
    hasMaximizedGroup: () => Boolean(maximized.group),
    exitMaximizedGroup: vi.fn(() => { maximized.group = undefined; }),
  } as unknown as DockviewApi;
  return { api, groups, addGroup, addPanel, active, maximized };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project review layout', () => {
  it('restores group tabs, active panel, focus, maximized group, and mounted panel nodes', () => {
    const focusTarget = {
      focus: vi.fn(),
      isConnected: true,
    } as unknown as HTMLElement;
    vi.stubGlobal('document', { activeElement: focusTarget });
    const workbench = fakeWorkbench();
    const left = workbench.addGroup('left', 0, 0, 700, 700);
    const right = workbench.addGroup('right', 700, 0, 300, 700);
    const terminal = workbench.addPanel('terminal', 'terminal', left);
    const files = workbench.addPanel('files', 'file-explorer', left);
    const agent = workbench.addPanel('agent', 'agent-session', right);
    const log = workbench.addPanel('log', 'agent-log', right);
    left.activePanel = files.panel;
    right.activePanel = agent.panel;
    workbench.active.panel = files.panel;
    workbench.maximized.group = right;
    const originalNodes = [...workbench.api.panels];
    const snapshot = captureProjectReviewLayout(workbench.api);

    expect(snapshot.maximizedGroupId).toBe('right');
    const editor = workbench.addPanel('editor', 'project-editor', left);
    expect(applyProjectReviewLayout(workbench.api, editor.panel)).toBe(true);
    expect(editor.panel.api.group.id).not.toBe(terminal.panel.api.group.id);
    expect(files.panel.api.group.activePanel?.id).toBe('files');
    expect(agent.panel.api.group.activePanel?.id).toBe('agent');
    expect(workbench.api.activePanel?.id).toBe('files');
    expect(workbench.maximized.group).toBe(right);
    expect(editor.setActive).not.toHaveBeenCalled();
    expect(editor.panel.api.group.api.setSize).toHaveBeenCalledWith({ height: 612 });

    editor.panel.api.setActive();
    right.activePanel = log.panel;
    workbench.maximized.group = editor.panel.api.group as unknown as FakeGroup;
    focusTarget.focus = vi.fn();

    expect(restoreProjectReviewLayout(workbench.api, snapshot)).toBe(true);
    expect(terminal.panel.api.group.id).toBe(files.panel.api.group.id);
    expect(agent.panel.api.group.id).toBe(log.panel.api.group.id);
    expect(agent.panel.api.group.id).not.toBe(terminal.panel.api.group.id);
    expect(editor.panel.api.group.id).toBe(files.panel.api.group.id);
    expect(files.panel.api.group.activePanel?.id).toBe('files');
    expect(agent.panel.api.group.activePanel?.id).toBe('agent');
    expect(workbench.api.activePanel?.id).toBe('files');
    expect(workbench.maximized.group?.panels).toContain(agent.panel);
    expect(focusTarget.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(workbench.api.panels).toEqual([...originalNodes, editor.panel]);
  });

  it('tabs the editor narrowly without stealing PTY activity or changing other group tabs', () => {
    const workbench = fakeWorkbench();
    const left = workbench.addGroup('left', 0, 0, 600, 700);
    const right = workbench.addGroup('right', 600, 0, 400, 700);
    const terminal = workbench.addPanel('terminal', 'terminal', left);
    workbench.addPanel('files', 'file-explorer', left);
    const agent = workbench.addPanel('agent', 'agent-session', right);
    const editor = workbench.addPanel('editor', 'project-editor', right);
    left.activePanel = terminal.panel;
    right.activePanel = agent.panel;
    workbench.active.panel = terminal.panel;
    workbench.maximized.group = right;

    expect(applyProjectReviewLayout(workbench.api, editor.panel, 'narrow')).toBe(true);
    expect(editor.panel.api.group.id).toBe(terminal.panel.api.group.id);
    expect(agent.panel.api.group.id).toBe(right.id);
    expect(left.activePanel?.id).toBe('terminal');
    expect(right.activePanel?.id).toBe('agent');
    expect(workbench.api.activePanel?.id).toBe('terminal');
    expect(workbench.maximized.group).toBe(right);
    expect(editor.setActive).not.toHaveBeenCalled();
  });

  it('preserves an explicitly active editor and follows its maximized group when narrow mode moves it', () => {
    const workbench = fakeWorkbench();
    const left = workbench.addGroup('left', 0, 0, 600, 700);
    const editorGroup = workbench.addGroup('editor-group', 600, 0, 400, 700);
    const terminal = workbench.addPanel('terminal', 'terminal', left);
    const editor = workbench.addPanel('editor', 'project-editor', editorGroup);
    left.activePanel = terminal.panel;
    editorGroup.activePanel = editor.panel;
    workbench.active.panel = editor.panel;
    workbench.maximized.group = editorGroup;

    expect(applyProjectReviewLayout(workbench.api, editor.panel, 'narrow')).toBe(true);
    expect(workbench.groups).not.toContain(editorGroup);
    expect(editor.panel.api.group.id).toBe(left.id);
    expect(workbench.maximized.group).toBe(left);
    expect(workbench.api.activePanel?.id).toBe('editor');
    expect(editor.setActive).toHaveBeenCalledOnce();
  });
});
