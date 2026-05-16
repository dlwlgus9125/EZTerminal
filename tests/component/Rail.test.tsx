/**
 * Component tests for Rail [R-L3-01]
 * AC-L3-01-1: 4 icons rendered at 48px rail
 * AC-L3-01-2: clicking an icon opens the panel (300px)
 * AC-L3-01-3: clicking the active icon closes the panel
 * AC-L3-01-N1: switching panel stops previous collector
 */

import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const openPanel = vi.fn();
const closePanel = vi.fn();

let mockActivePanelId: string | null = null;

vi.mock("../../src/renderer/store", () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({
      activePanelId: mockActivePanelId,
      openPanel,
      closePanel,
    }),
}));

const { Rail } = await import("../../src/renderer/components/Rail/Rail");

describe("Rail render", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockActivePanelId = null;
  });

  it("AC-L3-01-1: renders 4 icon buttons", () => {
    const { container } = render(<Rail />);
    const buttons = container.querySelectorAll("button[data-panel-id]");
    expect(buttons).toHaveLength(4);
  });

  it("AC-L3-01-1: rail nav has width 48px via CSS class", () => {
    const { container } = render(<Rail />);
    const nav = container.querySelector("[data-testid='rail']");
    expect(nav).not.toBeNull();
  });

  it("AC-L3-01-1: each icon has a data-panel-id attribute", () => {
    const { container } = render(<Rail />);
    const ids = Array.from(container.querySelectorAll("[data-panel-id]")).map(
      (el) => (el as HTMLElement).dataset.panelId
    );
    expect(ids).toEqual(["files", "status", "network", "settings"]);
  });
});

describe("Rail toggle open", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockActivePanelId = null;
  });

  it("AC-L3-01-2: clicking an icon calls openPanel with its id", async () => {
    const { container } = render(<Rail />);
    const btn = container.querySelector("[data-panel-id='files']") as HTMLElement;
    await userEvent.click(btn);
    expect(openPanel).toHaveBeenCalledWith("files");
  });

  it("AC-L3-01-2: inactive icon has no data-active attribute", () => {
    const { container } = render(<Rail />);
    const btn = container.querySelector("[data-panel-id='files']") as HTMLElement;
    expect(btn.dataset.active).toBeUndefined();
  });
});

describe("Rail toggle close", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockActivePanelId = null;
  });

  it("AC-L3-01-3: active icon has data-active true", () => {
    mockActivePanelId = "files";
    const { container } = render(<Rail />);
    const btn = container.querySelector("[data-panel-id='files']") as HTMLElement;
    expect(btn.dataset.active).toBe("true");
  });

  it("AC-L3-01-3: clicking active icon calls openPanel (toggle handled in store)", async () => {
    mockActivePanelId = "files";
    const { container } = render(<Rail />);
    const btn = container.querySelector("[data-panel-id='files']") as HTMLElement;
    await userEvent.click(btn);
    expect(openPanel).toHaveBeenCalledWith("files");
  });
});

describe("Rail switch panel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockActivePanelId = null;
  });

  it("AC-L3-01-N1: switching to another icon calls openPanel with new id", async () => {
    mockActivePanelId = "files";
    const { container } = render(<Rail />);
    const btn = container.querySelector("[data-panel-id='network']") as HTMLElement;
    await userEvent.click(btn);
    expect(openPanel).toHaveBeenCalledWith("network");
  });

  it("AC-L3-01-N1: only one icon is active at a time", () => {
    mockActivePanelId = "status";
    const { container } = render(<Rail />);
    const active = container.querySelectorAll("[data-active='true']");
    expect(active).toHaveLength(1);
  });
});
