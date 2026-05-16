/**
 * Component tests for FindBar [R-L4-05]
 * AC-L4-05-1: FindBar shows when findBarOpen=true
 * AC-L4-05-2: Search input calls onSearch and highlights
 * AC-L4-05-3: ESC closes the bar
 * AC-L4-05-N1: "No results" shown when search returns false
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FindBar } = await import("../../src/renderer/components/FindBar/FindBar");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── AC-L4-05-1: FindBar show ─────────────────────────────────────────────────

describe("FindBar show", () => {
  it("renders find bar element", () => {
    const onClose = vi.fn();
    const onSearch = vi.fn().mockReturnValue(true);
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    expect(screen.getByTestId("find-bar")).toBeInTheDocument();
  });

  it("renders input with placeholder 'Find...'", () => {
    const onClose = vi.fn();
    const onSearch = vi.fn().mockReturnValue(true);
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    expect(screen.getByPlaceholderText("Find...")).toBeInTheDocument();
  });

  it("renders close button", () => {
    const onClose = vi.fn();
    const onSearch = vi.fn().mockReturnValue(true);
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    expect(screen.getByTestId("find-bar-close")).toBeInTheDocument();
  });
});

// ── AC-L4-05-2: FindBar search ───────────────────────────────────────────────

describe("FindBar search", () => {
  it("typing calls onSearch with the query", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    await user.type(screen.getByTestId("find-bar-input"), "hello");
    expect(onSearch).toHaveBeenCalledWith(expect.stringContaining("h"));
  });

  it("pressing Enter calls onSearch with current query", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    const input = screen.getByTestId("find-bar-input");
    await user.type(input, "test");
    await user.keyboard("{Enter}");
    expect(onSearch).toHaveBeenCalledWith("test");
  });
});

// ── AC-L4-05-3: FindBar close ────────────────────────────────────────────────

describe("FindBar close", () => {
  it("clicking close button calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSearch = vi.fn().mockReturnValue(true);
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    await user.click(screen.getByTestId("find-bar-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("pressing ESC calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSearch = vi.fn().mockReturnValue(true);
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    const input = screen.getByTestId("find-bar-input");
    await user.type(input, "q");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ── AC-L4-05-N1: FindBar no results ─────────────────────────────────────────

describe("FindBar no results", () => {
  it("shows 'No results' when onSearch returns false", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(false);
    const onClose = vi.fn();
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    await user.type(screen.getByTestId("find-bar-input"), "xyz");
    expect(screen.getByTestId("find-bar-no-results")).toBeInTheDocument();
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("does not show 'No results' when onSearch returns true", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    await user.type(screen.getByTestId("find-bar-input"), "hello");
    expect(screen.queryByTestId("find-bar-no-results")).toBeNull();
  });

  it("hides 'No results' when input is cleared", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn().mockReturnValue(false);
    const onClose = vi.fn();
    render(<FindBar onClose={onClose} onSearch={onSearch} />);
    const input = screen.getByTestId("find-bar-input");
    await user.type(input, "xyz");
    expect(screen.getByTestId("find-bar-no-results")).toBeInTheDocument();
    await user.clear(input);
    expect(screen.queryByTestId("find-bar-no-results")).toBeNull();
  });
});
