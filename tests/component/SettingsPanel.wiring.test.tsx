/**
 * Wiring tests for SettingsPanel [R-L3-07, R-L3-08]
 * W1: visible=true → settings:load IPC
 * W2: form submit → settings:save IPC with updated data
 * W3: validation block → no IPC call
 * W4: save success → "Saved" status shown
 * W5: save failure → error status shown
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSettings } from "../../src/shared/settings-types";

function makeSettings(): UserSettings {
  return {
    terminal: { fontSize: 14, fontFamily: "monospace", scrollbackLimit: 1000, theme: "dark" },
    shell: { defaultShell: "", startupArgs: [] },
    language: "en",
    updatedAt: 0,
  };
}

beforeEach(() => {
  vi.mocked(window.electronAPI.settings.load).mockResolvedValue({
    ok: true,
    data: makeSettings() as unknown as UserSettings,
  });
  vi.mocked(window.electronAPI.settings.save).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { SettingsPanel } = await import(
  "../../src/renderer/components/panels/SettingsPanel/SettingsPanel"
);

// ─── W1: visible → settings:load ─────────────────────────────────────────────

describe("W1 visible → settings:load", () => {
  it("isVisible=true calls settings.load", async () => {
    render(<SettingsPanel isVisible={true} />);
    await waitFor(() => {
      expect(window.electronAPI.settings.load).toHaveBeenCalledOnce();
    });
  });

  it("isVisible=false does not call settings.load", () => {
    render(<SettingsPanel isVisible={false} />);
    expect(window.electronAPI.settings.load).not.toHaveBeenCalled();
  });

  it("loaded data populates form fields", async () => {
    vi.mocked(window.electronAPI.settings.load).mockResolvedValue({
      ok: true,
      data: {
        ...makeSettings(),
        terminal: { ...makeSettings().terminal, fontSize: 20, fontFamily: "JetBrains Mono" },
      } as unknown as UserSettings,
    });

    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      const fsInput = screen.getByTestId("settings-font-size") as HTMLInputElement;
      expect(fsInput.value).toBe("20");
    });
  });
});

// ─── W2: submit → settings:save ───────────────────────────────────────────────

describe("W2 submit → settings:save", () => {
  it("submitting the form calls settings.save once", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(window.electronAPI.settings.save).toHaveBeenCalledOnce();
    });
  });

  it("saved payload has terminal property", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      const [payload] = vi.mocked(window.electronAPI.settings.save).mock.calls[0] as [UserSettings];
      expect(payload.terminal).toBeDefined();
      expect(typeof payload.terminal.fontSize).toBe("number");
    });
  });

  it("saved payload has updatedAt set to current time", async () => {
    const user = userEvent.setup();
    const before = Date.now();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      const [payload] = vi.mocked(window.electronAPI.settings.save).mock.calls[0] as [UserSettings];
      expect(payload.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });
});

// ─── W3: validation → no IPC ─────────────────────────────────────────────────

describe("W3 validation → no IPC on invalid", () => {
  it("invalid font size blocks save IPC", async () => {
    const user = userEvent.setup();
    // Load with spaces-only fontFamily — invalid, blocks save
    vi.mocked(window.electronAPI.settings.load).mockResolvedValue({
      ok: true,
      data: {
        terminal: { fontSize: 14, fontFamily: "   ", scrollbackLimit: 1000, theme: "dark" },
        shell: { defaultShell: "", startupArgs: [] },
        language: "en",
        updatedAt: 0,
      } as unknown as UserSettings,
    });

    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      const input = screen.getByTestId("settings-font-family") as HTMLInputElement;
      expect(input.value).toBe("   ");
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-validation-error")).toBeInTheDocument();
    });
    expect(window.electronAPI.settings.save).not.toHaveBeenCalled();
  });
});

// ─── W4: save success → Saved status ─────────────────────────────────────────

describe("W4 save success → Saved status", () => {
  it("successful save shows settings-status-saved", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-status-saved")).toBeInTheDocument();
    });
  });

  it("successful save does not show error status", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-status-saved")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-testid='settings-status-error']")).toBeNull();
  });
});

// ─── W5: save failure → error status ─────────────────────────────────────────

describe("W5 save failure → error status", () => {
  it("failed save shows settings-status-error", async () => {
    vi.mocked(window.electronAPI.settings.save).mockResolvedValue({
      ok: false,
      error: "Write failed",
    });

    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-status-error")).toBeInTheDocument();
    });
  });

  it("failed save does not show saved status", async () => {
    vi.mocked(window.electronAPI.settings.save).mockResolvedValue({
      ok: false,
      error: "Disk error",
    });

    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-status-error")).toBeInTheDocument();
    });

    expect(document.querySelector("[data-testid='settings-status-saved']")).toBeNull();
  });
});
