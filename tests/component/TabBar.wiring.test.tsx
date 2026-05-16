/**
 * Wiring tests for TabBar [R-L2-06]
 * W1: store tabs → tab button list
 * W2: addTab button → layoutSlice.addTab()
 * W3: tab click → layoutSlice.switchTab(id)
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/store", () => {
  const addTab = vi.fn();
  const switchTab = vi.fn();

  const tab1 = { id: "w1", layout: { type: "leaf", paneId: "p1" }, activePaneId: "p1" };
  const tab2 = { id: "w2", layout: { type: "leaf", paneId: "p2" }, activePaneId: "p2" };

  const state = {
    tabs: { w1: tab1, w2: tab2 },
    activeTabId: "w1",
    switchTab,
    addTab,
  };

  return {
    useStore: (selector: (s: typeof state) => unknown) => selector(state),
    __addTab: addTab,
    __switchTab: switchTab,
  };
});

const { TabBar } = await import("../../src/renderer/components/TabBar/TabBar");
const storeMock = await import("../../src/renderer/store");
const addTab = (storeMock as { __addTab: ReturnType<typeof vi.fn> }).__addTab;
const switchTab = (storeMock as { __switchTab: ReturnType<typeof vi.fn> }).__switchTab;

describe("W1 store tabs → tab list", () => {
  afterEach(() => cleanup());

  it("renders one button per tab in store", () => {
    render(<TabBar />);
    const tabs = screen.getAllByRole("button", { name: /^Tab \d+$/ });
    expect(tabs).toHaveLength(2);
  });

  it("active tab button has data-active true", () => {
    const { container } = render(<TabBar />);
    const active = container.querySelector("[data-active='true']") as HTMLElement;
    expect(active?.dataset.tabId).toBe("w1");
  });
});

describe("W2 add tab wiring", () => {
  afterEach(() => cleanup());

  it("add button click calls store addTab", async () => {
    const { container } = render(<TabBar />);
    const btn = container.querySelector("[data-add-tab]") as HTMLElement;
    await userEvent.click(btn);
    expect(addTab).toHaveBeenCalledOnce();
  });
});

describe("W3 tab switch wiring", () => {
  afterEach(() => cleanup());

  it("clicking tab calls switchTab with tab id", async () => {
    const { container } = render(<TabBar />);
    const tab = container.querySelector("[data-tab-id='w2']") as HTMLElement;
    await userEvent.click(tab);
    expect(switchTab).toHaveBeenCalledWith("w2");
  });
});
