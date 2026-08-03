// @vitest-environment jsdom

import { Settings } from 'lucide-react';
import { act, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Button,
  Dialog,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingState,
  Menu,
  MenuItem,
  MenuRadioItem,
  Popover,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  ToastProvider,
  useToast,
  VisuallyHidden,
} from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function press(target: EventTarget, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey }));
  });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('buttons and form controls', () => {
  it('makes loading buttons busy, disabled, and still screen-reader named', () => {
    const onClick = vi.fn();
    render(<Button loading loadingLabel="Deploying" onClick={onClick}>Deploy</Button>);
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Deploy');
    expect(button.textContent).toContain('Deploying');
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('requires an accessible icon-button label and hides the icon from assistive tech', () => {
    render(<IconButton icon={Settings} aria-label="Settings" />);
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Settings');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('connects a field label, required state, and validation error to its input', () => {
    render(
      <Field label="Host" description="Server hostname" error="Host is required" required>
        <Input />
      </Field>,
    );
    const label = container.querySelector('label')!;
    const input = container.querySelector<HTMLInputElement>('input')!;
    const error = container.querySelector('[role="alert"]')!;
    expect(label.htmlFor).toBe(input.id);
    expect(input.required).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
  });

  it('uses a native checkbox with switch semantics and a visible label', () => {
    const onChange = vi.fn();
    render(<Switch label="CRT scanlines" checked onChange={onChange} />);
    const input = container.querySelector<HTMLInputElement>('[role="switch"]')!;
    expect(input.checked).toBe(true);
    expect(container.querySelector('label')?.textContent).toContain('CRT scanlines');
    act(() => input.click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

function TabsHarness(): JSX.Element {
  const [value, setValue] = useState('general');
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabList label="Settings sections">
        <Tab value="general">General</Tab>
        <Tab value="disabled" disabled>Disabled</Tab>
        <Tab value="terminal">Terminal</Tab>
      </TabList>
      <TabPanel value="general">General panel</TabPanel>
      <TabPanel value="terminal">Terminal panel</TabPanel>
    </Tabs>
  );
}

describe('keyboard navigation and overlays', () => {
  it('roves tabs with arrow keys, skips disabled tabs, and activates automatically', () => {
    render(<TabsHarness />);
    const general = container.querySelector<HTMLButtonElement>('[data-value="general"]')!;
    const terminal = container.querySelector<HTMLButtonElement>('[data-value="terminal"]')!;
    general.focus();
    press(general, 'ArrowRight');
    expect(document.activeElement).toBe(terminal);
    expect(terminal.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('Terminal panel');
  });

  it('opens a menu, roves its items, activates with Enter, closes, and restores focus', () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <Menu trigger={<button type="button">Actions</button>} label="Panel actions">
        <MenuItem onSelect={first}>Rename</MenuItem>
        <MenuItem onSelect={second}>Close</MenuItem>
      </Menu>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    act(() => trigger.click());
    const items = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    press(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1], 'Enter');
    expect(second).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses the first menu item before a newly opened menu can receive keyboard input', () => {
    const pendingFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    render(
      <Menu trigger={<button type="button">Actions</button>} label="Panel actions">
        <MenuItem onSelect={vi.fn()}>Rename</MenuItem>
        <MenuItem onSelect={vi.fn()}>Close</MenuItem>
      </Menu>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    act(() => trigger.click());
    const firstItem = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

    expect(document.activeElement).toBe(firstItem);
  });

  it('includes mutually exclusive radio items in initial focus and arrow navigation', () => {
    const selectStatic = vi.fn();
    const selectCrt = vi.fn();
    render(
      <Menu trigger={<button type="button">Effects</button>} label="Effect profile">
        <MenuRadioItem checked={false} onSelect={selectStatic}>
          Static
        </MenuRadioItem>
        <MenuRadioItem checked onSelect={selectCrt}>
          CRT
        </MenuRadioItem>
      </Menu>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    act(() => trigger.click());
    const items = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect(document.activeElement).toBe(items[0]);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    press(items[0], 'ArrowDown');
    press(items[1], 'Enter');
    expect(selectCrt).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it('opens with ArrowUp on the last enabled item and ArrowDown on the first enabled item', () => {
    render(
      <Menu trigger={<button type="button">Effects</button>} label="Effect profile">
        <MenuRadioItem checked={false} onSelect={vi.fn()}>
          Static
        </MenuRadioItem>
        <MenuRadioItem checked onSelect={vi.fn()}>
          CRT
        </MenuRadioItem>
        <MenuRadioItem checked={false} disabled onSelect={vi.fn()}>
          Unavailable
        </MenuRadioItem>
      </Menu>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button')!;

    trigger.focus();
    press(trigger, 'ArrowUp');
    expect(document.activeElement?.textContent).toBe('CRT');
    press(document.activeElement!, 'Escape');
    expect(document.activeElement).toBe(trigger);

    press(trigger, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Static');
  });

  it('exposes popover state and returns focus to its trigger on Escape', () => {
    render(
      <Popover trigger={<button type="button">Details</button>} ariaLabel="Connection details" initialFocus>
        <button type="button">Copy address</button>
      </Popover>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Connection details');
    press(document, 'Escape');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

function DialogHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  const safeActionRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" data-testid="dialog-opener" onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delete preset?"
        description="This cannot be undone."
        initialFocusRef={safeActionRef}
        footer={<button type="button">Delete</button>}
      >
        <button ref={safeActionRef} type="button">Cancel</button>
      </Dialog>
    </>
  );
}

function StackedDialogHarness(): JSX.Element {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="outer-opener" onClick={() => setOuterOpen(true)}>
        Open outer
      </button>
      <Dialog open={outerOpen} onOpenChange={setOuterOpen} title="Outer" testId="outer-dialog">
        <button type="button" data-testid="inner-opener" onClick={() => setInnerOpen(true)}>
          Open inner
        </button>
        <button type="button">Outer action</button>
        <Dialog open={innerOpen} onOpenChange={setInnerOpen} title="Inner" testId="inner-dialog">
          <button type="button" data-testid="inner-action">Inner action</button>
        </Dialog>
      </Dialog>
    </>
  );
}

function RerenderingDialogHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <button type="button" data-testid="rerender-dialog-opener" onClick={() => setOpen(true)}>
        Open rerendering dialog
      </button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
        title={`Rerendering dialog ${revision}`}
        testId="rerendering-dialog"
      >
        <button type="button">First action</button>
        <button
          type="button"
          data-testid="rerender-dialog-action"
          onClick={() => setRevision((current) => current + 1)}
        >
          Rerender
        </button>
      </Dialog>
    </>
  );
}

describe('modal and feedback semantics', () => {
  it('focuses the safe dialog action, closes with Escape, and restores opener focus', () => {
    render(<DialogHarness />);
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="dialog-opener"]')!;
    opener.focus();
    act(() => opener.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Cancel');
    press(document, 'Escape');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('lets only the topmost nested dialog trap focus and consume Escape', () => {
    render(<StackedDialogHarness />);
    const outerOpener = container.querySelector<HTMLButtonElement>('[data-testid="outer-opener"]')!;
    outerOpener.focus();
    act(() => outerOpener.click());
    const innerOpener = document.body.querySelector<HTMLButtonElement>('[data-testid="inner-opener"]')!;
    innerOpener.focus();
    act(() => innerOpener.click());

    const outer = document.body.querySelector<HTMLElement>('[data-testid="outer-dialog"]')!;
    const inner = document.body.querySelector<HTMLElement>('[data-testid="inner-dialog"]')!;
    outer.querySelector<HTMLButtonElement>('button')!.focus();
    press(document, 'Tab');
    expect(inner.contains(document.activeElement)).toBe(true);

    press(document, 'Escape');
    expect(document.body.querySelector('[data-testid="inner-dialog"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="outer-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(innerOpener);

    press(document, 'Escape');
    expect(document.body.querySelector('[data-testid="outer-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outerOpener);
  });

  it('preserves the active control when an open dialog parent rerenders', () => {
    render(<RerenderingDialogHarness />);
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="rerender-dialog-opener"]')!;
    opener.focus();
    act(() => opener.click());

    const rerenderAction = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="rerender-dialog-action"]',
    )!;
    rerenderAction.focus();
    act(() => rerenderAction.click());

    expect(document.body.querySelector('[data-testid="rerendering-dialog"]')?.textContent)
      .toContain('Rerendering dialog 1');
    expect(document.activeElement).toBe(rerenderAction);
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
  });

  it('announces loading and error states without relying on colour alone', () => {
    render(
      <>
        <LoadingState label="Loading sessions" />
        <ErrorState title="Could not connect" description="Check the address and try again." />
        <VisuallyHidden>Screen-reader context</VisuallyHidden>
      </>,
    );
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not connect');
    expect(container.querySelector('.ez-ui-visually-hidden')?.textContent).toBe('Screen-reader context');
  });
});

function ToastHarness(): JSX.Element {
  const { pushToast } = useToast();
  return (
    <button
      type="button"
      onClick={() => pushToast({ title: 'Saved', description: 'Preset updated', variant: 'success', duration: 0 })}
    >
      Save
    </button>
  );
}

describe('toast provider', () => {
  it('creates a labelled live notification and lets the user dismiss it', () => {
    render(
      <ToastProvider viewportLabel="App notifications">
        <ToastHarness />
      </ToastProvider>,
    );
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    const viewport = document.body.querySelector('[role="region"]')!;
    const toast = viewport.querySelector('[role="status"]')!;
    expect(viewport.getAttribute('aria-label')).toBe('App notifications');
    expect(toast.textContent).toContain('Preset updated');
    act(() => toast.querySelector<HTMLButtonElement>('button')!.click());
    expect(viewport.querySelector('[role="status"]')).toBeNull();
  });
});
