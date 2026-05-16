/**
 * Wiring tests for CommandPalette [R-L4-03]
 * W1: input change → filtered list
 * W2: keyboard nav → activeIdx changes
 * W3: command click/enter → action + close
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../../src/renderer/components/CommandPalette/CommandPalette";
import type { PaletteCommand } from "../../src/renderer/components/CommandPalette/CommandPalette";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeCommands(count = 5): PaletteCommand[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cmd-${i}`,
    label: `Command ${i}`,
    action: vi.fn(),
  }));
}

describe("W1 input → filter", () => {
  it("typing in input filters visible options", async () => {
    const commands: PaletteCommand[] = [
      { id: "a", label: "Alpha Command", action: vi.fn() },
      { id: "b", label: "Beta Task", action: vi.fn() },
      { id: "c", label: "Gamma Alpha", action: vi.fn() },
    ];
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    await userEvent.type(screen.getByTestId("palette-input"), "alpha");
    const items = within(screen.getByTestId("palette-list")).getAllByRole("option");
    expect(items).toHaveLength(2); // Alpha Command + Gamma Alpha
  });

  it("empty query shows all commands", async () => {
    const commands = makeCommands(5);
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const items = within(screen.getByTestId("palette-list")).getAllByRole("option");
    expect(items).toHaveLength(5);
  });
});

describe("W2 keyboard nav → activeIdx", () => {
  it("first item is active by default", () => {
    const commands = makeCommands(3);
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const items = within(screen.getByTestId("palette-list")).getAllByRole("option");
    expect(items[0]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowDown increments active item", () => {
    const commands = makeCommands(3);
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "ArrowDown" });
    const items = within(screen.getByTestId("palette-list")).getAllByRole("option");
    expect(items[1]).toHaveAttribute("aria-selected", "true");
    expect(items[0]).toHaveAttribute("aria-selected", "false");
  });

  it("ArrowUp from first wraps to last", () => {
    const commands = makeCommands(3);
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "ArrowUp" });
    const items = within(screen.getByTestId("palette-list")).getAllByRole("option");
    expect(items[2]).toHaveAttribute("aria-selected", "true");
  });
});

describe("W3 command → action + close", () => {
  it("Enter executes active command action", () => {
    const commands = makeCommands(3);
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Enter" });
    expect(commands[0].action as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking second item executes its action", async () => {
    const commands = makeCommands(3);
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} />);
    const items = within(screen.getByTestId("palette-list")).getAllByRole("option");
    await userEvent.click(items[1] as HTMLElement);
    expect(commands[1].action as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
