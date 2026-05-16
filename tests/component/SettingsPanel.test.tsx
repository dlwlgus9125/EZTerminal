/**
 * Component tests for SettingsPanel [R-L3-07]
 * AC-L3-07-1: settings load
 * AC-L3-07-2: settings save
 * AC-L3-07-3: immediate apply
 * AC-L3-07-N1: invalid value rejected
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSettings } from "../../src/shared/settings-types";

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    terminal: {
      fontSize: 16,
      fontFamily: "Fira Code",
      scrollbackLimit: 2000,
      theme: "dark",
    },
    shell: {
      defaultShell: "/bin/zsh",
      startupArgs: [],
    },
    language: "en",
    updatedAt: 0,
    ...overrides,
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

// ─── Load ─────────────────────────────────────────────────────────────────────

describe("Settings load", () => {
  it("AC-L3-07-1: Settings load — calls settings.load when visible", async () => {
    render(<SettingsPanel isVisible={true} />);
    await waitFor(() => {
      expect(window.electronAPI.settings.load).toHaveBeenCalledOnce();
    });
  });

  it("AC-L3-07-1: Settings load — displays loaded font size", async () => {
    render(<SettingsPanel isVisible={true} />);
    await waitFor(() => {
      const input = screen.getByTestId("settings-font-size") as HTMLInputElement;
      expect(input.value).toBe("16");
    });
  });

  it("AC-L3-07-1: Settings load — displays loaded font family", async () => {
    render(<SettingsPanel isVisible={true} />);
    await waitFor(() => {
      const input = screen.getByTestId("settings-font-family") as HTMLInputElement;
      expect(input.value).toBe("Fira Code");
    });
  });

  it("AC-L3-07-1: Settings load — displays loaded shell", async () => {
    render(<SettingsPanel isVisible={true} />);
    await waitFor(() => {
      const input = screen.getByTestId("settings-shell") as HTMLInputElement;
      expect(input.value).toBe("/bin/zsh");
    });
  });

  it("does not call settings.load when not visible", () => {
    render(<SettingsPanel isVisible={false} />);
    expect(window.electronAPI.settings.load).not.toHaveBeenCalled();
  });

  it("Settings file load — settings panel has data-testid", () => {
    render(<SettingsPanel isVisible={true} />);
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
  });
});

// ─── Save ─────────────────────────────────────────────────────────────────────

describe("Settings save", () => {
  it("AC-L3-07-2: Settings save — calls settings.save on form submit", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-font-size")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(window.electronAPI.settings.save).toHaveBeenCalledOnce();
    });
  });

  it("AC-L3-07-2: Settings save — saved settings contain terminal config", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-font-size")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      const [savedSettings] = vi.mocked(window.electronAPI.settings.save).mock.calls[0] as [
        UserSettings,
      ];
      expect(savedSettings.terminal).toBeDefined();
    });
  });

  it("AC-L3-07-2: Settings save — shows saved status after successful save", async () => {
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

  it("AC-L3-07-2: Settings save — shows error status on failed save", async () => {
    vi.mocked(window.electronAPI.settings.save).mockResolvedValue({
      ok: false,
      error: "Disk full",
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
});

// ─── Apply ────────────────────────────────────────────────────────────────────

describe("Settings apply", () => {
  it("AC-L3-07-3: Settings apply — save sends settings with updatedAt timestamp", async () => {
    const user = userEvent.setup();
    const before = Date.now();
    render(<SettingsPanel isVisible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      const [saved] = vi.mocked(window.electronAPI.settings.save).mock.calls[0] as [UserSettings];
      expect(saved.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("Settings validation", () => {
  it("AC-L3-07-N1: Settings validation — shows validation error for invalid font family", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.settings.load).mockResolvedValue({
      ok: true,
      // fontFamily is spaces-only — invalid
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

  it("AC-L3-07-N1: Settings validation — validation blocks save when fontFamily is whitespace", async () => {
    const user = userEvent.setup();
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
      expect(screen.getByTestId("settings-save")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-validation-error")).toBeInTheDocument();
    });
    expect(window.electronAPI.settings.save).not.toHaveBeenCalled();
  });
});
