/**
 * Wiring tests for ContextMenu [R-L4-02]
 * W1: item click → action handler invoked
 * W2: disabled item → action not invoked
 * W3: keyboard ArrowDown/Up/Enter → proper focus/action
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

describe("W1 item click → handler", () => {
  it("clicking Find calls onFind", async () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "Find" }));
    expect(handlers.onFind).toHaveBeenCalledTimes(1);
  });

  it("clicking Split Right calls onSplitRight", async () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "Split Right" }));
    expect(handlers.onSplitRight).toHaveBeenCalledTimes(1);
  });

  it("clicking New Tab calls onNewTab", async () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "New Tab" }));
    expect(handlers.onNewTab).toHaveBeenCalledTimes(1);
  });
});

describe("W2 disabled item → no action", () => {
  it("Copy is disabled when hasSelection=false", () => {
    const handlers = makeHandlers({ hasSelection: false });
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const copyBtn = screen.getByRole("menuitem", { name: "Copy" });
    expect(copyBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("clicking disabled Copy does not call onCopy or onClose", async () => {
    const handlers = makeHandlers({ hasSelection: false });
    const onClose = vi.fn();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    const copyBtn = screen.getByRole("menuitem", { name: "Copy" });
    await userEvent.click(copyBtn, { pointerEventsCheck: 0 });
    expect(handlers.onCopy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("W3 keyboard nav → focus + action", () => {
  it("ArrowDown from Paste focuses Select All", () => {
    const handlers = makeHandlers();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    const allMenuItems = within(menu).getAllByRole("menuitem");
    // Focus Paste (index 1 of enabled items)
    const pasteBtn = screen.getByRole("menuitem", { name: "Paste" });
    pasteBtn.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Select All should now be focused
    const selectAllBtn = screen.getByRole("menuitem", { name: "Select All" });
    expect(document.activeElement).toBe(selectAllBtn);
    void allMenuItems;
  });

  it("Enter on a focused item calls the action", () => {
    const handlers = makeHandlers();
    const onClose = vi.fn();
    const items = buildTerminalContextMenu(handlers);
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    const menu = screen.getByTestId("context-menu");
    const selectAllBtn = screen.getByRole("menuitem", { name: "Select All" });
    selectAllBtn.focus();
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(handlers.onSelectAll).toHaveBeenCalled();
  });
});
