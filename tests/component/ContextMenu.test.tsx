/**
 * Component tests for ContextMenu [R-L4-02]
 * AC-L4-02-1: right-click shows menu with 13 items at cursor position
 * AC-L4-02-2: keyboard nav (ArrowDown/Up/Enter)
 * AC-L4-02-3: screen boundary overflow detection
 * AC-L4-02-N1: copy disabled when no selection
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  buildTerminalContextMenu,
} from "../../src/renderer/components/ContextMenu/ContextMenu";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeHandlers(overrides: Partial<Parameters<typeof buildTerminalContextMenu>[0]> = {}) {
  return {
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onSelectAll: vi.fn(),
    onFind: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onClosePane: vi.fn(),
    onNewTab: vi.fn(),
    onCloseTab: vi.fn(),
    hasSelection: true,
    ...overrides,
  };
}

describe("ContextMenu show", () => {
  it("ContextMenu show - renders menu portal at specified coordinates", () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={100} y={200} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    expect(menu).not.toBeNull();
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("200px");
  });

  it("ContextMenu show - renders 9 action items + 4 separators = 13 entries", () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    // Count: Copy, Paste, Select All (3) + sep + Find (1) + sep + Split Right, Split Down, Close Pane (3) + sep + New Tab, Close Tab (2) + sep = 9 items + 4 seps = 13
    expect(items.length).toBe(13);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    const menuItems = within(menu).getAllByRole("menuitem");
    expect(menuItems).toHaveLength(9);
    const seps = within(menu).getAllByRole("separator");
    expect(seps).toHaveLength(4);
  });

  it("ContextMenu show - clicking an item triggers its action and calls onClose", async () => {
    const handlers = makeHandlers();
    const onClose = vi.fn();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    const pasteBtn = screen.getByRole("menuitem", { name: "Paste" });
    await userEvent.click(pasteBtn);
    expect(handlers.onPaste).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ContextMenu show - Escape key calls onClose", async () => {
    const handlers = makeHandlers();
    const onClose = vi.fn();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ContextMenu keyboard", () => {
  it("ContextMenu keyboard - ArrowDown moves focus to next item", async () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    // Focus menu
    const firstItem = within(menu).getAllByRole("menuitem")[0] as HTMLElement;
    firstItem.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    const secondItem = within(menu).getAllByRole("menuitem")[1] as HTMLElement;
    expect(document.activeElement).toBe(secondItem);
  });

  it("ContextMenu keyboard - ArrowUp wraps to last item", async () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    const firstItem = within(menu).getAllByRole("menuitem")[0] as HTMLElement;
    firstItem.focus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    const allItems = within(menu).getAllByRole("menuitem");
    // Last enabled item
    const lastEnabled = allItems[allItems.length - 1] as HTMLElement;
    expect(document.activeElement).toBe(lastEnabled);
  });

  it("ContextMenu keyboard - Enter on focused item triggers action", async () => {
    const handlers = makeHandlers();
    const onClose = vi.fn();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    const menu = screen.getByTestId("context-menu");
    const pasteBtn = within(menu).getByRole("menuitem", { name: "Paste" }) as HTMLButtonElement;
    pasteBtn.focus();
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(handlers.onPaste).toHaveBeenCalled();
  });
});

describe("ContextMenu overflow", () => {
  it("ContextMenu overflow - menu flips left when x+width exceeds viewport", () => {
    // Window is 1024px wide, position near right edge
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 400 });
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={350} y={0} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    // left should be clamped: 400-200=200
    expect(Number.parseInt(menu.style.left ?? "350")).toBeLessThanOrEqual(200);
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
  });

  it("ContextMenu overflow - menu flips up when y+height exceeds viewport", () => {
    Object.defineProperty(window, "innerHeight", {
      writable: true,
      configurable: true,
      value: 300,
    });
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={280} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    expect(Number.parseInt(menu.style.top ?? "280")).toBeLessThan(280);
    Object.defineProperty(window, "innerHeight", {
      writable: true,
      configurable: true,
      value: 768,
    });
  });
});

describe("ContextMenu copy disabled", () => {
  it("ContextMenu copy disabled - Copy item has aria-disabled when hasSelection=false", () => {
    const handlers = makeHandlers({ hasSelection: false });
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const copyBtn = screen.getByRole("menuitem", { name: "Copy" });
    expect(copyBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("ContextMenu copy disabled - clicking disabled Copy does not call onCopy", async () => {
    const handlers = makeHandlers({ hasSelection: false });
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const copyBtn = screen.getByRole("menuitem", { name: "Copy" });
    await userEvent.click(copyBtn, { pointerEventsCheck: 0 });
    expect(handlers.onCopy).not.toHaveBeenCalled();
  });
});
