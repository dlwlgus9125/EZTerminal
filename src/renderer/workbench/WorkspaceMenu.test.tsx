// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppHeader } from './AppHeader';
import { WorkspaceMenu } from './WorkspaceMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <AppHeader
      attentionCount={0}
      commandCenterOpen={false}
      effectIntensity={7}
      onNewTerminal={vi.fn()}
      onOpenAttention={vi.fn()}
      onOpenCommandCenter={vi.fn()}
      onOpenEffectSettings={vi.fn()}
      onWorkspaceOpenChange={setOpen}
      workspaceOpen={open}
      workspaceMenu={open ? (
        <WorkspaceMenu
          names={['Daily']}
          nameDraft=""
          onApply={vi.fn()}
          onDelete={vi.fn()}
          onNameDraftChange={vi.fn()}
          onSave={vi.fn()}
          onSetSaving={vi.fn()}
          onSplitDown={vi.fn()}
          onSplitRight={vi.fn()}
          onToggleStartup={vi.fn()}
          saving={false}
          startupPreset="Daily"
        />
      ) : undefined}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('WorkspaceMenu accessibility', () => {
  it('keeps four product zones while exposing the full brand and one effect-intensity control', () => {
    expect(container.querySelectorAll('.workbench-header > .workbench-header-zone')).toHaveLength(4);
    expect(container.querySelector('h1')?.textContent).toBe('EZTerminal');

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="btn-effect-profile"]')!;
    expect(trigger.dataset.effectIntensity).toBe('7');
    expect(trigger.textContent).toContain('NEON 7');
    act(() => trigger.click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('uses a non-modal dialog model for mixed actions and form controls', () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="btn-workspace-menu"]')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');

    act(() => trigger.click());

    const dialog = container.querySelector<HTMLElement>('[data-testid="preset-menu"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Workspace');
    expect(dialog.querySelector('[role="menuitem"]')).toBeNull();
    expect(dialog.querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector('[data-testid="btn-split-right"]'));
  });
});
