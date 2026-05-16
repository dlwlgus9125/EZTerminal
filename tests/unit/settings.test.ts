/**
 * Unit tests for SettingsManager [R-L3-07, R-L3-08]
 * AC-L3-07-1: settings load
 * AC-L3-07-2: settings save
 * AC-L3-07-3: immediate apply (validate method)
 * AC-L3-07-N1: invalid value rejected
 * AC-L3-08-1: file read
 * AC-L3-08-2: atomic write
 * AC-L3-08-3: default creation
 * AC-L3-08-N1: corrupt JSON recovery
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRename = vi.fn();
const mockMkdir = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    rename: mockRename,
    mkdir: mockMkdir,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rename: mockRename,
  mkdir: mockMkdir,
}));

const { SettingsManager } = await import("../../src/main/settings");

const SETTINGS_PATH = path.join("/tmp", "settings.json");

function makeValidSettings() {
  return {
    terminal: {
      fontSize: 14,
      fontFamily: "monospace",
      scrollbackLimit: 1000,
      theme: "dark" as const,
    },
    shell: { defaultShell: undefined, startupArgs: [] },
    language: "en",
    updatedAt: 0,
  };
}

describe("Settings load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  it("AC-L3-08-1: Settings file load — reads settings from JSON file", async () => {
    const settings = makeValidSettings();
    mockReadFile.mockResolvedValue(JSON.stringify(settings));

    const mgr = new SettingsManager(SETTINGS_PATH);
    const result = await mgr.load();

    expect(result.terminal.fontSize).toBe(14);
    expect(result.terminal.theme).toBe("dark");
  });

  it("AC-L3-07-1: Settings load — returns parsed settings object", async () => {
    const settings = makeValidSettings();
    settings.terminal.fontSize = 18;
    mockReadFile.mockResolvedValue(JSON.stringify(settings));

    const mgr = new SettingsManager(SETTINGS_PATH);
    const result = await mgr.load();
    expect(result.terminal.fontSize).toBe(18);
  });

  it("AC-L3-08-3: Settings default — creates defaults when file missing", async () => {
    const err = Object.assign(new Error("File not found"), { code: "ENOENT" });
    mockReadFile.mockRejectedValue(err);

    const mgr = new SettingsManager(SETTINGS_PATH);
    const result = await mgr.load();

    expect(result.terminal.fontSize).toBe(14);
    expect(result.terminal.theme).toBe("dark");
    // Should have written defaults to disk (atomic write = writeFile + rename)
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockRename).toHaveBeenCalled();
  });

  it("AC-L3-08-N1: Settings corrupt — recovers from corrupt JSON", async () => {
    mockReadFile.mockResolvedValue("{ invalid json !!!");

    const mgr = new SettingsManager(SETTINGS_PATH);
    const result = await mgr.load();

    expect(result.terminal.fontSize).toBe(14); // defaults restored
    // Wrote defaults back
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("AC-L3-08-N1: Settings corrupt — recovers from invalid structure (no terminal key)", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ foo: "bar" }));

    const mgr = new SettingsManager(SETTINGS_PATH);
    const result = await mgr.load();
    expect(result.terminal).toBeDefined();
  });
});

describe("Settings save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  it("AC-L3-07-2: Settings save — writes settings to disk", async () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    await mgr.save(makeValidSettings());
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("AC-L3-08-2: Settings atomic write — writes to .tmp file first", async () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    await mgr.save(makeValidSettings());

    const writeCall = mockWriteFile.mock.calls[0];
    expect(writeCall?.[0]).toContain(".tmp");
  });

  it("AC-L3-08-2: Settings atomic write — renames .tmp to target path", async () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    await mgr.save(makeValidSettings());

    expect(mockRename).toHaveBeenCalledWith(expect.stringContaining(".tmp"), SETTINGS_PATH);
  });

  it("AC-L3-08-2: Settings atomic write — creates directory if missing", async () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    await mgr.save(makeValidSettings());

    expect(mockMkdir).toHaveBeenCalledWith(path.dirname(SETTINGS_PATH), { recursive: true });
  });

  it("AC-L3-07-2: Settings save — written JSON is parseable", async () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    await mgr.save(makeValidSettings());

    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    expect(() => JSON.parse(written)).not.toThrow();
    const parsed = JSON.parse(written);
    expect(parsed.terminal.fontSize).toBe(14);
  });
});

describe("Settings validate", () => {
  it("AC-L3-07-N1: Settings validation — rejects negative font size", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    const s = makeValidSettings();
    s.terminal.fontSize = -1;
    expect(mgr.validate(s)).toBe(false);
  });

  it("AC-L3-07-N1: Settings validation — rejects zero font size", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    const s = makeValidSettings();
    s.terminal.fontSize = 0;
    expect(mgr.validate(s)).toBe(false);
  });

  it("AC-L3-07-N1: Settings validation — rejects empty fontFamily", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    const s = makeValidSettings();
    s.terminal.fontFamily = "   ";
    expect(mgr.validate(s)).toBe(false);
  });

  it("AC-L3-07-N1: Settings validation — rejects invalid theme", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    const s = {
      ...makeValidSettings(),
      // biome-ignore lint/suspicious/noExplicitAny: test invalid value
      terminal: { ...makeValidSettings().terminal, theme: "banana" as any },
    };
    expect(mgr.validate(s)).toBe(false);
  });

  it("AC-L3-07-3: Settings apply — valid settings pass validation", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    expect(mgr.validate(makeValidSettings())).toBe(true);
  });

  it("AC-L3-07-N1: Settings validation — rejects null", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    expect(mgr.validate(null)).toBe(false);
  });

  it("AC-L3-07-N1: Settings validation — rejects string", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    expect(mgr.validate("nope")).toBe(false);
  });
});

describe("Settings defaults", () => {
  it("AC-L3-08-3: Settings default — defaults() returns valid settings", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    const d = mgr.defaults();
    expect(d.terminal.fontSize).toBe(14);
    expect(d.terminal.theme).toBe("dark");
    expect(d.shell.startupArgs).toEqual([]);
  });

  it("AC-L3-08-3: Settings default — defaults() returns independent copies", () => {
    const mgr = new SettingsManager(SETTINGS_PATH);
    const d1 = mgr.defaults();
    const d2 = mgr.defaults();
    d1.terminal.fontSize = 99;
    expect(d2.terminal.fontSize).toBe(14);
  });
});
