/**
 * Component tests for CommandPalette [R-L4-03]
 * AC-L4-03-1: palette shows on mount with all commands
 * AC-L4-03-2: substring filter narrows list
 * AC-L4-03-3: Enter executes selected command
 * AC-L4-03-N1: no match shows "No commands found"
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  buildAppCommands,
} from "../../src/renderer/components/CommandPalette/CommandPalette";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function noop(): void {}

function makeCommands(overrides: Partial<Parameters<typeof buildAppCommands>[0]> = {}) {
  return buildAppCommands({
    onNewTab: noop,
    onCloseTab: noop,
    onSplitRight: noop,
    onSplitDown: noop,
    onClosePane: noop,
    onNextTab: noop,
    onFind: noop,
    onSaveScrollback: noop,
    onToggleFiles: noop,
    onToggleStatus: noop,
    onToggleNetwork: noop,
    onToggleSettings: noop,
    onToggleCommandPalette: noop,
    ...overrides,
  });
}

describe("Palette show", () => {
  it("Palette show - renders palette overlay with input", () => {
    const commands = makeCommands();
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    expect(screen.getByTestId("command-palette")).not.toBeNull();
    expect(screen.getByTestId("palette-input")).not.toBeNull();
  });

  it("Palette show - renders all 14 commands by default", () => {
    const commands = makeCommands();
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const list = screen.getByTestId("palette-list");
    const items = within(list).getAllByRole("option");
    expect(items).toHaveLength(14);
  });

  it("Palette show - Escape calls onClose", () => {
    const commands = makeCommands();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Palette filter", () => {
  it("Palette filter - typing 'tab' shows only tab-related commands", async () => {
    const commands = makeCommands();
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const input = screen.getByTestId("palette-input");
    await userEvent.type(input, "tab");
    const list = screen.getByTestId("palette-list");
    const items = within(list).queryAllByRole("option");
    // Matching: "New Tab", "Close Tab", "Next Tab", "Toggle Command Palette"... but palette has no "tab"
    // Items with 'tab' (case-insensitive): New Tab, Close Tab, Next Tab = 3
    for (const item of items) {
      expect(item.textContent?.toLowerCase()).toContain("tab");
    }
    expect(items.length).toBeGreaterThan(0);
  });

  it("Palette filter - substring match is case-insensitive", async () => {
    const commands = makeCommands();
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const input = screen.getByTestId("palette-input");
    await userEvent.type(input, "SPLIT");
    const list = screen.getByTestId("palette-list");
    const items = within(list).queryAllByRole("option");
    expect(items.length).toBe(2); // Split Right, Split Down
  });

  it("Palette filter - clearing query restores all commands", async () => {
    const commands = makeCommands();
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const input = screen.getByTestId("palette-input");
    await userEvent.type(input, "split");
    await userEvent.clear(input);
    const list = screen.getByTestId("palette-list");
    const items = within(list).queryAllByRole("option");
    expect(items).toHaveLength(14);
  });
});

describe("Palette execute", () => {
  it("Palette execute - Enter executes the active (first) command and closes", () => {
    const onNewTab = vi.fn();
    const onClose = vi.fn();
    const commands = makeCommands({ onNewTab });
    render(<CommandPalette commands={commands} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Enter" });
    expect(onNewTab).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Palette execute - ArrowDown moves selection then Enter executes second command", () => {
    const onCloseTab = vi.fn();
    const onClose = vi.fn();
    const commands = makeCommands({ onCloseTab });
    render(<CommandPalette commands={commands} onClose={onClose} />);
    const palette = screen.getByTestId("command-palette");
    fireEvent.keyDown(palette, { key: "ArrowDown" });
    fireEvent.keyDown(palette, { key: "Enter" });
    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });

  it("Palette execute - clicking an item executes it and closes", async () => {
    const onSplitRight = vi.fn();
    const onClose = vi.fn();
    const commands = makeCommands({ onSplitRight });
    render(<CommandPalette commands={commands} onClose={onClose} />);
    const item = screen.getByTestId("palette-item-split-right");
    await userEvent.click(item);
    expect(onSplitRight).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Palette no match", () => {
  it("Palette no match - shows 'No commands found' for unrecognized query", async () => {
    const commands = makeCommands();
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const input = screen.getByTestId("palette-input");
    await userEvent.type(input, "xyzzy_nonexistent");
    expect(screen.getByTestId("palette-no-match")).not.toBeNull();
    expect(screen.getByTestId("palette-no-match").textContent).toBe("No commands found");
  });

  it("Palette no match - Enter on empty result does nothing and does not close", () => {
    const onClose = vi.fn();
    const commands: import(
      "../../src/renderer/components/CommandPalette/CommandPalette"
    ).PaletteCommand[] = [];
    render(<CommandPalette commands={commands} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
