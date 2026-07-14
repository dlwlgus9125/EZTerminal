// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { RecentPanelSwitcher } from './RecentPanelSwitcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('RecentPanelSwitcher', () => {
  it('renders an accessible listbox with cwd, textual state, and selected announcement', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(
      <RecentPanelSwitcher
        selectedPanelId="pane-2"
        items={[
          { panelId: 'pane-1', title: 'Shell', detail: 'C:\\work', statuses: ['Current'] },
          { panelId: 'pane-2', title: 'Agent', detail: '/repo', statuses: ['Busy', 'Agent waiting'] },
        ]}
      />,
    ));

    const list = container.querySelector('[role="listbox"]')!;
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(2);
    expect(list.getAttribute('aria-activedescendant')).toBe('recent-panel-option-pane-2');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[1].textContent).toContain('/repo');
    expect(options[1].textContent).toContain('Agent waiting');
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('Agent, /repo, Busy, Agent waiting');
  });
});
