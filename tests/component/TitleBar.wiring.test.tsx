/**
 * Wiring tests for TitleBar [R-L2-05]
 * W1: drag region → -webkit-app-region: drag
 * W2: control buttons → electronAPI.window IPC calls
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

const { TitleBar } = await import("../../src/renderer/components/TitleBar/TitleBar");

describe("W1 drag region wiring", () => {
  afterEach(() => cleanup());

  it("data-drag-region element exists inside title bar", () => {
    const { container } = render(<TitleBar />);
    const dragEl = container.querySelector("[data-drag-region]");
    expect(dragEl).not.toBeNull();
  });

  it("drag region style includes webkit-app-region drag", () => {
    const { container } = render(<TitleBar />);
    const dragEl = container.querySelector("[data-drag-region]") as HTMLElement;
    const regionValue =
      dragEl.style.webkitAppRegion ?? dragEl.style.getPropertyValue("-webkit-app-region");
    expect(regionValue).toBe("drag");
  });
});

describe("W2 IPC control wiring", () => {
  afterEach(() => cleanup());

  it("minimize button wired to electronAPI.window.minimize", async () => {
    render(<TitleBar />);
    await userEvent.click(screen.getByLabelText("Minimize"));
    expect(window.electronAPI.window.minimize).toHaveBeenCalled();
  });

  it("maximize button wired to electronAPI.window.maximize", async () => {
    render(<TitleBar />);
    await userEvent.click(screen.getByLabelText("Maximize"));
    expect(window.electronAPI.window.maximize).toHaveBeenCalled();
  });

  it("close button wired to electronAPI.window.close", async () => {
    render(<TitleBar />);
    await userEvent.click(screen.getByLabelText("Close"));
    expect(window.electronAPI.window.close).toHaveBeenCalled();
  });
});
