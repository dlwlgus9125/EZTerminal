/**
 * Vitest setup file for component tests (jsdom environment).
 * Runs before each component test file.
 */

import "@testing-library/jest-dom";
import { afterEach, vi } from "vitest";

// Set up data-theme='dark' on document for Phosphor token tests
document.documentElement.setAttribute("data-theme", "dark");

// Mock window.electronAPI — renderer components expect this to exist
const mockElectronAPI = {
  pty: {
    create: vi.fn().mockResolvedValue({ ok: true, data: "mock-pty-id" }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {}),
  },
  settings: {
    load: vi.fn().mockResolvedValue({ ok: true, data: null }),
    save: vi.fn().mockResolvedValue({ ok: true }),
  },
  metrics: {
    start: vi.fn(),
    stop: vi.fn(),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  },
  network: {
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    onTraffic: vi.fn().mockReturnValue(() => {}),
  },
  fs: {
    readDir: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    watch: vi.fn(),
    stopWatch: vi.fn(),
    onChanged: vi.fn().mockReturnValue(() => {}),
  },
  window: {
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
  },
};

Object.defineProperty(window, "electronAPI", {
  value: mockElectronAPI,
  writable: true,
  configurable: true,
});

// Reset all mocks between tests
afterEach(() => {
  vi.clearAllMocks();
});
