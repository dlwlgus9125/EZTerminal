/**
 * Component tests for SplitContainer [R-L2-04]
 * AC-L2-04-1: CSS Grid horizontal 2 pane
 * AC-L2-04-2: 6px gutter drag ratio adjustment
 * AC-L2-04-3: double-click 50:50 reset
 * AC-L2-04-N1: invalid LayoutNode fallback
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNode } from "../../src/renderer/store/layout-slice";

// Dynamically import after mocks are set up
const { SplitContainer } = await import(
  "../../src/renderer/components/SplitContainer/SplitContainer"
);

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function leafNode(id: string): LayoutNode {
  return { type: "leaf", paneId: id };
}

function hSplit(left: LayoutNode, right: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: "split", direction: "horizontal", children: [left, right], ratio };
}

function vSplit(top: LayoutNode, bottom: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: "split", direction: "vertical", children: [top, bottom], ratio };
}

// Default renderLeaf callback — renders a div with data-pane-id
function renderLeaf(paneId: string) {
  return <div data-testid={`pane-${paneId}`} />;
}

// ──────────────────────────────────────────────
// SplitContainer render
// ──────────────────────────────────────────────

describe("SplitContainer render", () => {
  afterEach(() => cleanup());

  it("AC-L2-04-1: horizontal split renders CSS Grid with two columns", () => {
    const node = hSplit(leafNode("a"), leafNode("b"), 0.4);
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);

    const splitEl = container.querySelector("[data-split-direction='horizontal']");
    expect(splitEl).not.toBeNull();

    const style = window.getComputedStyle(splitEl as Element);
    // grid-template-columns should reflect the 0.4 ratio: "40fr 6px 60fr"
    expect((splitEl as HTMLElement).style.gridTemplateColumns).toMatch(/fr.*fr/);
  });

  it("vertical split renders CSS Grid with two rows", () => {
    const node = vSplit(leafNode("a"), leafNode("b"), 0.3);
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);

    const splitEl = container.querySelector("[data-split-direction='vertical']");
    expect(splitEl).not.toBeNull();
    expect((splitEl as HTMLElement).style.gridTemplateRows).toMatch(/fr.*fr/);
  });

  it("leaf renders renderLeaf output", () => {
    const node = leafNode("my-pane");
    render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    expect(screen.getByTestId("pane-my-pane")).toBeInTheDocument();
  });

  it("renders both panes in horizontal split", () => {
    const node = hSplit(leafNode("left"), leafNode("right"));
    render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    expect(screen.getByTestId("pane-left")).toBeInTheDocument();
    expect(screen.getByTestId("pane-right")).toBeInTheDocument();
  });

  it("gutter element is present in split", () => {
    const node = hSplit(leafNode("a"), leafNode("b"));
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    expect(container.querySelector("[data-gutter]")).not.toBeNull();
  });
});

// ──────────────────────────────────────────────
// SplitContainer gutter drag
// ──────────────────────────────────────────────

describe("SplitContainer gutter drag", () => {
  afterEach(() => cleanup());

  it("AC-L2-04-2: drag on horizontal gutter calls onRatioChange with updated ratio", async () => {
    const onRatioChange = vi.fn();
    const node = hSplit(leafNode("a"), leafNode("b"), 0.5);

    const { container } = render(
      <SplitContainer node={node} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
    );

    const gutter = container.querySelector("[data-gutter]") as HTMLElement;
    expect(gutter).not.toBeNull();

    // Simulate mousedown → mousemove → mouseup
    const splitEl = container.querySelector("[data-split-direction]") as HTMLElement;
    // Mock getBoundingClientRect so ratio math is deterministic
    Object.defineProperty(splitEl, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 200, top: 0, height: 200 }),
      configurable: true,
    });

    gutter.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    // ratio should have moved: 120/200 = 0.6
    expect(onRatioChange).toHaveBeenCalled();
    const [newRatio] = onRatioChange.mock.calls[onRatioChange.mock.calls.length - 1];
    expect(newRatio).toBeCloseTo(0.6, 1);
  });

  it("drag on vertical gutter computes ratio from clientY", async () => {
    const onRatioChange = vi.fn();
    const node = vSplit(leafNode("a"), leafNode("b"), 0.5);

    const { container } = render(
      <SplitContainer node={node} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
    );

    const gutter = container.querySelector("[data-gutter]") as HTMLElement;
    const splitEl = container.querySelector("[data-split-direction]") as HTMLElement;
    Object.defineProperty(splitEl, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 200, top: 0, height: 200 }),
      configurable: true,
    });

    gutter.dispatchEvent(new MouseEvent("mousedown", { clientY: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 60, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(onRatioChange).toHaveBeenCalled();
    const [newRatio] = onRatioChange.mock.calls[onRatioChange.mock.calls.length - 1];
    expect(newRatio).toBeCloseTo(0.3, 1);
  });
});

// ──────────────────────────────────────────────
// SplitContainer reset
// ──────────────────────────────────────────────

describe("SplitContainer reset", () => {
  afterEach(() => cleanup());

  it("AC-L2-04-3: double-click on gutter calls onRatioChange with 0.5", async () => {
    const onRatioChange = vi.fn();
    const node = hSplit(leafNode("a"), leafNode("b"), 0.3);

    const { container } = render(
      <SplitContainer node={node} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
    );

    const gutter = container.querySelector("[data-gutter]") as HTMLElement;
    gutter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onRatioChange).toHaveBeenCalledWith(0.5);
  });
});

// ──────────────────────────────────────────────
// SplitContainer invalid node
// ──────────────────────────────────────────────

describe("SplitContainer invalid node", () => {
  afterEach(() => cleanup());

  it("AC-L2-04-N1: invalid node type renders fallback without crashing", () => {
    // Force-cast an invalid node
    const badNode = { type: "unknown", paneId: "x" } as unknown as LayoutNode;
    const { container } = render(<SplitContainer node={badNode} renderLeaf={renderLeaf} />);
    // Should not throw; renders something (even empty)
    expect(container).toBeDefined();
    // No gutter, no leaf
    expect(container.querySelector("[data-gutter]")).toBeNull();
    expect(container.querySelector("[data-testid]")).toBeNull();
  });
});
