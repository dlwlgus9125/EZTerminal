/**
 * Wiring tests for Rail [R-L3-01]
 * W1: panelSlice.activePanelId → active icon indicator
 * W2: icon click → panelSlice.openPanel(id) toggle action
 */

import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const openPanel = vi.fn();
let mockActivePanelId: string | null = null;

vi.mock("../../src/renderer/store", () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({
      activePanelId: mockActivePanelId,
      openPanel,
    }),
}));

const { Rail } = await import("../../src/renderer/components/Rail/Rail");

describe("W1 binding panelSlice → active icon", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockActivePanelId = null;
  });

  it("no active panel → no icon has data-active", () => {
    mockActivePanelId = null;
    const { container } = render(<Rail />);
    expect(container.querySelectorAll("[data-active='true']")).toHaveLength(0);
  });

  it("activePanelId='network' → network icon has data-active true", () => {
    mockActivePanelId = "network";
    const { container } = render(<Rail />);
    const active = container.querySelector("[data-active='true']") as HTMLElement;
    expect(active?.dataset.panelId).toBe("network");
  });

  it("only the matching icon gets data-active", () => {
    mockActivePanelId = "settings";
    const { container } = render(<Rail />);
    const active = container.querySelectorAll("[data-active='true']");
    expect(active).toHaveLength(1);
  });
});

describe("W2 handler click → toggle action", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockActivePanelId = null;
  });

  it("click files → openPanel('files')", async () => {
    const { container } = render(<Rail />);
    await userEvent.click(container.querySelector("[data-panel-id='files']") as HTMLElement);
    expect(openPanel).toHaveBeenCalledWith("files");
  });

  it("click status → openPanel('status')", async () => {
    const { container } = render(<Rail />);
    await userEvent.click(container.querySelector("[data-panel-id='status']") as HTMLElement);
    expect(openPanel).toHaveBeenCalledWith("status");
  });

  it("click active icon also calls openPanel (store handles toggle logic)", async () => {
    mockActivePanelId = "files";
    const { container } = render(<Rail />);
    await userEvent.click(container.querySelector("[data-panel-id='files']") as HTMLElement);
    expect(openPanel).toHaveBeenCalledWith("files");
  });
});
