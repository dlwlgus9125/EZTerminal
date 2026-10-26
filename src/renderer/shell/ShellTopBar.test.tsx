// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../i18n';
import { ShellTopBar, type ShellTopBarProps } from './ShellTopBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  // jsdom lays nothing out: the tab strip's reveal has nothing to scroll.
  Element.prototype.scrollIntoView ??= () => undefined;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function render(locale: 'ko' | 'en'): Pick<ShellTopBarProps, 'onAddProject' | 'onAllProjects'> {
  const handlers = { onAddProject: vi.fn(), onAllProjects: vi.fn() };
  act(() => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      <ShellTopBar
        mode="board"
        projects={[{ projectId: 'p-ez', name: 'EZTerminal', pinned: true }]}
        selectedProjectId="p-ez"
        waitingByProject={{}}
        stoppedProjects={new Set()}
        waitingTotal={0}
        host={{ label: 'This PC', tone: 'idle' }}
        onSelectProject={vi.fn()}
        onWaits={vi.fn()}
        onFind={vi.fn()}
        onHost={vi.fn()}
        onSettings={vi.fn()}
        {...handlers}
      />
    </AppI18nProvider>,
  ));
  return handlers;
}
const byTestId = (id: string): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

describe('ShellTopBar project buttons', () => {
  it('adds a project with + and lists every project with 모든 프로젝트', () => {
    const handlers = render('ko');
    expect(byTestId('shell-add-project').getAttribute('aria-label')).toBe('프로젝트 추가');
    expect(byTestId('shell-all-projects').getAttribute('aria-label')).toBe('모든 프로젝트');
    act(() => byTestId('shell-add-project').click());
    act(() => byTestId('shell-all-projects').click());
    expect(handlers.onAddProject).toHaveBeenCalledOnce();
    expect(handlers.onAllProjects).toHaveBeenCalledOnce();
  });

  it('keeps both outside the scrolling tab list, and no longer opens a project sidebar', () => {
    render('en');
    const tabs = container.querySelector('nav')!;
    expect(tabs.contains(byTestId('shell-add-project'))).toBe(false);
    expect(tabs.contains(byTestId('shell-all-projects'))).toBe(false);
    expect(byTestId('shell-add-project').getAttribute('aria-label')).toBe('Add project');
    expect(byTestId('shell-all-projects').getAttribute('aria-label')).toBe('All projects');
    expect(container.querySelector('[data-testid="rail-agents"]')).toBeNull();
  });
});
