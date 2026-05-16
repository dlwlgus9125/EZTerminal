/**
 * Wiring tests for SplitContainer [R-L2-04]
 * W1: LayoutNode → grid binding
 * W2: gutter drag → ratio update handler
 * W5: split vs leaf rendering template
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutNode } from "../../src/renderer/store/layout-slice";

const { SplitContainer } = await import(
  "../../src/renderer/components/SplitContainer/SplitContainer"
);

function leafNode(id: string): LayoutNode {
  return { type: "leaf", paneId: id };
}

function renderLeaf(paneId: string) {
  return <div data-testid={`pane-${paneId}`} />;
}

// ──────────────────────────────────────────────
// W1: LayoutNode → grid binding
// ──────────────────────────────────────────────

describe("W1 LayoutNode → grid", () => {
  afterEach(() => cleanup());

  it("horizontal split sets gridTemplateColumns proportional to ratio", () => {
    const node: LayoutNode = {
      type: "split",
      direction: "horizontal",
      children: [leafNode("a"), leafNode("b")],
      ratio: 0.7,
    };
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    const el = container.querySelector("[data-split-direction='horizontal']") as HTMLElement;
    // "70fr 6px 30fr" (or equivalent)
    const cols = el.style.gridTemplateColumns;
    expect(cols).toContain("70");
    expect(cols).toContain("30");
    expect(cols).toContain("6px");
  });

  it("vertical split sets gridTemplateRows proportional to ratio", () => {
    const node: LayoutNode = {
      type: "split",
      direction: "vertical",
      children: [leafNode("a"), leafNode("b")],
      ratio: 0.25,
    };
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    const el = container.querySelector("[data-split-direction='vertical']") as HTMLElement;
    const rows = el.style.gridTemplateRows;
    expect(rows).toContain("25");
    expect(rows).toContain("75");
    expect(rows).toContain("6px");
  });
});

// ──────────────────────────────────────────────
// W2: gutter drag → ratio update handler
// ──────────────────────────────────────────────

describe("W2 gutter drag → ratio update", () => {
  afterEach(() => cleanup());

  it("invokes onRatioChange during mousemove after mousedown on gutter", () => {
    const onRatioChange = vi.fn();
    const node: LayoutNode = {
      type: "split",
      direction: "horizontal",
      children: [leafNode("a"), leafNode("b")],
      ratio: 0.5,
    };
    const { container } = render(
      <SplitContainer node={node} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
    );
    const gutter = container.querySelector("[data-gutter]") as HTMLElement;
    const splitEl = container.querySelector("[data-split-direction]") as HTMLElement;

    Object.defineProperty(splitEl, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 400, top: 0, height: 400 }),
      configurable: true,
    });

    gutter.dispatchEvent(new MouseEvent("mousedown", { clientX: 200, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, bubbles: true }));

    expect(onRatioChange).toHaveBeenCalled();
  });

  it("stops invoking onRatioChange after mouseup", () => {
    const onRatioChange = vi.fn();
    const node: LayoutNode = {
      type: "split",
      direction: "horizontal",
      children: [leafNode("a"), leafNode("b")],
      ratio: 0.5,
    };
    const { container } = render(
      <SplitContainer node={node} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
    );
    const gutter = container.querySelector("[data-gutter]") as HTMLElement;
    const splitEl = container.querySelector("[data-split-direction]") as HTMLElement;

    Object.defineProperty(splitEl, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 400, top: 0, height: 400 }),
      configurable: true,
    });

    gutter.dispatchEvent(new MouseEvent("mousedown", { clientX: 200, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    const callCountAfterUp = onRatioChange.mock.calls.length;

    // Further moves should NOT trigger
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 350, bubbles: true }));
    expect(onRatioChange.mock.calls.length).toBe(callCountAfterUp);
  });
});

// ──────────────────────────────────────────────
// W5: split vs leaf rendering template
// ──────────────────────────────────────────────

describe("W5 split vs leaf template", () => {
  afterEach(() => cleanup());

  it("leaf node does not produce a split container element", () => {
    const node = leafNode("solo");
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    expect(container.querySelector("[data-split-direction]")).toBeNull();
  });

  it("split node produces a split container element", () => {
    const node: LayoutNode = {
      type: "split",
      direction: "horizontal",
      children: [leafNode("a"), leafNode("b")],
      ratio: 0.5,
    };
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    expect(container.querySelector("[data-split-direction='horizontal']")).not.toBeNull();
  });

  it("nested split renders three leaf nodes", () => {
    const node: LayoutNode = {
      type: "split",
      direction: "horizontal",
      children: [
        leafNode("a"),
        {
          type: "split",
          direction: "vertical",
          children: [leafNode("b"), leafNode("c")],
          ratio: 0.5,
        },
      ],
      ratio: 0.5,
    };
    const { container } = render(<SplitContainer node={node} renderLeaf={renderLeaf} />);
    expect(container.querySelectorAll("[data-testid]").length).toBe(3);
  });
});
