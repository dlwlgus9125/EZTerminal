/**
 * Wiring tests for FindBar [R-L4-05]
 * W1: SearchAddon → highlight binding (onSearch routes to SearchAddon.findNext)
 * W2: Enter → findNext handler
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { FindBar } = await import("../../src/renderer/components/FindBar/FindBar");

// ── W1: SearchAddon → highlight binding ──────────────────────────────────────

describe("W1 SearchAddon → highlight", () => {
  it("onSearch is called with typed query (simulates SearchAddon.findNext routing)", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();

    render(<FindBar onClose={onClose} onSearch={onSearch} />);

    await user.type(screen.getByTestId("find-bar-input"), "term");

    // Each keystroke calls onSearch with incremental query
    expect(onSearch).toHaveBeenCalled();
    const lastCall = onSearch.mock.calls[onSearch.mock.calls.length - 1] as [string];
    expect(lastCall[0]).toBe("term");
  });

  it("onSearch returns false triggers no-results indicator", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(false);
    const onClose = vi.fn();

    render(<FindBar onClose={onClose} onSearch={onSearch} />);

    await user.type(screen.getByTestId("find-bar-input"), "missing");
    expect(screen.getByTestId("find-bar-no-results")).toBeInTheDocument();
  });
});

// ── W2: Enter → findNext handler ─────────────────────────────────────────────

describe("W2 Enter → findNext", () => {
  it("Enter key invokes onSearch with the current query", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();

    render(<FindBar onClose={onClose} onSearch={onSearch} />);

    const input = screen.getByTestId("find-bar-input");
    // Type then Enter — should call onSearch with the full query
    fireEvent.change(input, { target: { value: "grep" } });
    await user.keyboard("{Enter}");

    expect(onSearch).toHaveBeenCalledWith("grep");
  });

  it("Enter with empty query does not call onSearch", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();

    render(<FindBar onClose={onClose} onSearch={onSearch} />);

    // Input stays empty
    await user.keyboard("{Enter}");
    // onSearch should not be invoked for empty query
    expect(onSearch).not.toHaveBeenCalled();
  });
});
