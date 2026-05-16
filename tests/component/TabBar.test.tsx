/**
 * Component tests for TabBar [R-L2-06]
 * AC-L2-06-1: tab list rendering (tabs + active indicator)
 * AC-L2-06-2: new tab button calls addTab
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the store so we can control state
vi.mock("../../src/renderer/store", () => {
  const addTab = vi.fn();
  const switchTab = vi.fn();

  const tab1 = { id: "t1", layout: { type: "leaf", paneId: "p1" }, activePaneId: "p1" };
  const tab2 = { id: "t2", layout: { type: "leaf", paneId: "p2" }, activePaneId: "p2" };
  const tab3 = { id: "t3", layout: { type: "leaf", paneId: "p3" }, activePaneId: "p3" };

  const state = {
    tabs: { t1: tab1, t2: tab2, t3: tab3 },
    activeTabId: "t2",
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

describe("TabBar render", () => {
  afterEach(() => cleanup());

  it("AC-L2-06-1: renders 3 tabs", () => {
    render(<TabBar />);
    const tabs = screen.getAllByRole("button", { name: /^Tab \d+$/ });
    expect(tabs).toHaveLength(3);
  });

  it("AC-L2-06-1: active tab has data-active attribute", () => {
    const { container } = render(<TabBar />);
    const activeTab = container.querySelector("[data-active='true']") as HTMLElement;
    expect(activeTab).not.toBeNull();
    expect(activeTab.dataset.tabId).toBe("t2");
  });

  it("AC-L2-06-1: only one tab is active", () => {
    const { container } = render(<TabBar />);
    const activeTabs = container.querySelectorAll("[data-active='true']");
    expect(activeTabs).toHaveLength(1);
  });

  it("clicking a tab calls switchTab with the tab id", async () => {
    const { container } = render(<TabBar />);
    const tab = container.querySelector("[data-tab-id='t1']") as HTMLElement;
    await userEvent.click(tab);
    expect(switchTab).toHaveBeenCalledWith("t1");
  });
});

describe("TabBar add", () => {
  afterEach(() => cleanup());

  it("AC-L2-06-2: add button is rendered", () => {
    const { container } = render(<TabBar />);
    expect(container.querySelector("[data-add-tab]")).not.toBeNull();
  });

  it("AC-L2-06-2: clicking add button calls addTab", async () => {
    const { container } = render(<TabBar />);
    const addBtn = container.querySelector("[data-add-tab]") as HTMLElement;
    await userEvent.click(addBtn);
    expect(addTab).toHaveBeenCalledOnce();
  });
});
