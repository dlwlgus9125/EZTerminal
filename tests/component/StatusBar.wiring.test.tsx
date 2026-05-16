/**
 * Wiring tests for StatusBar [R-L2-07]
 * W1: props → shell/size/encoding segments
 * W2: default props match spec (PowerShell 80x24 UTF-8)
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const { StatusBar } = await import("../../src/renderer/components/StatusBar/StatusBar");

describe("W1 props → segments", () => {
  afterEach(() => cleanup());

  it("shellName prop flows to shell segment", () => {
    const { container } = render(<StatusBar shellName="zsh" />);
    const seg = container.querySelector("[data-segment='shell']");
    expect(seg?.textContent).toBe("zsh");
  });

  it("cols and rows props flow to size segment", () => {
    const { container } = render(<StatusBar cols={100} rows={30} />);
    const seg = container.querySelector("[data-segment='size']");
    expect(seg?.textContent).toBe("100x30");
  });

  it("encoding prop flows to encoding segment", () => {
    const { container } = render(<StatusBar encoding="ASCII" />);
    const seg = container.querySelector("[data-segment='encoding']");
    expect(seg?.textContent).toBe("ASCII");
  });
});

describe("W2 default spec values", () => {
  afterEach(() => cleanup());

  it("default shell is PowerShell", () => {
    render(<StatusBar />);
    expect(screen.getByText("PowerShell")).toBeInTheDocument();
  });

  it("default size is 80x24", () => {
    render(<StatusBar />);
    expect(screen.getByText("80x24")).toBeInTheDocument();
  });

  it("default encoding is UTF-8", () => {
    render(<StatusBar />);
    expect(screen.getByText("UTF-8")).toBeInTheDocument();
  });
});
