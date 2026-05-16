/**
 * Component tests for TitleBar [R-L2-05]
 * AC-L2-05-1: drag region (-webkit-app-region: drag)
 * AC-L2-05-2: window controls (min/max/close IPC)
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

const { TitleBar } = await import("../../src/renderer/components/TitleBar/TitleBar");

describe("TitleBar drag", () => {
  afterEach(() => cleanup());

  it("AC-L2-05-1: drag region has -webkit-app-region drag style", () => {
    const { container } = render(<TitleBar />);
    const dragEl = container.querySelector("[data-drag-region]") as HTMLElement;
    expect(dragEl).not.toBeNull();
    expect(dragEl.style.webkitAppRegion ?? dragEl.style.getPropertyValue("-webkit-app-region")).toBe(
      "drag"
    );
  });
});

describe("TitleBar controls", () => {
  afterEach(() => cleanup());

  it("AC-L2-05-2: minimize button calls window.electronAPI.window.minimize", async () => {
    render(<TitleBar />);
    const btn = screen.getByLabelText("Minimize");
    await userEvent.click(btn);
    expect(window.electronAPI.window.minimize).toHaveBeenCalledOnce();
  });

  it("AC-L2-05-2: maximize button calls window.electronAPI.window.maximize", async () => {
    render(<TitleBar />);
    const btn = screen.getByLabelText("Maximize");
    await userEvent.click(btn);
    expect(window.electronAPI.window.maximize).toHaveBeenCalledOnce();
  });

  it("AC-L2-05-2: close button calls window.electronAPI.window.close", async () => {
    render(<TitleBar />);
    const btn = screen.getByLabelText("Close");
    await userEvent.click(btn);
    expect(window.electronAPI.window.close).toHaveBeenCalledOnce();
  });

  it("all three control buttons are rendered", () => {
    const { container } = render(<TitleBar />);
    expect(container.querySelector("[data-control='minimize']")).not.toBeNull();
    expect(container.querySelector("[data-control='maximize']")).not.toBeNull();
    expect(container.querySelector("[data-control='close']")).not.toBeNull();
  });
});
