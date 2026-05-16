/**
 * Component tests for StatusBar [R-L2-07]
 * AC-L2-07-1: status display (shell name, cols x rows, encoding)
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const { StatusBar } = await import("../../src/renderer/components/StatusBar/StatusBar");

describe("StatusBar display", () => {
  afterEach(() => cleanup());

  it("AC-L2-07-1: renders default PowerShell 80x24 UTF-8", () => {
    render(<StatusBar />);
    expect(screen.getByText("PowerShell")).toBeInTheDocument();
    expect(screen.getByText("80x24")).toBeInTheDocument();
    expect(screen.getByText("UTF-8")).toBeInTheDocument();
  });

  it("renders custom shell name", () => {
    render(<StatusBar shellName="bash" />);
    expect(screen.getByText("bash")).toBeInTheDocument();
  });

  it("renders custom cols and rows", () => {
    render(<StatusBar cols={120} rows={40} />);
    expect(screen.getByText("120x40")).toBeInTheDocument();
  });

  it("renders custom encoding", () => {
    render(<StatusBar encoding="UTF-16" />);
    expect(screen.getByText("UTF-16")).toBeInTheDocument();
  });

  it("shell segment has data-segment attribute", () => {
    const { container } = render(<StatusBar />);
    expect(container.querySelector("[data-segment='shell']")).not.toBeNull();
    expect(container.querySelector("[data-segment='size']")).not.toBeNull();
    expect(container.querySelector("[data-segment='encoding']")).not.toBeNull();
  });
});
