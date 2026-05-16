/**
 * Unit tests for PtyManager (T1+T2 scope):
 * - create: spawn PTY, return IpcResult<string> with session ID
 * - kill: terminate PTY, remove from Map
 * - cleanup: before-quit kill all sessions
 * - orphan: 30s scan removes dead processes
 * - error paths: invalid shell, nonexistent session kill
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockIPty, mockNodePty, resetNodePtyMocks } from "../mocks/node-pty";

// Mock node-pty before importing PtyManager
vi.mock("node-pty", () => mockNodePty);

// Import after mock is set up
const { PtyManager } = await import("../../src/main/pty-manager");

describe("PtyManager create", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.clearAllMocks();
  });

  it("returns ok result with a session ID string", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data).toBe("string");
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  it("session ID is unique across multiple creates", async () => {
    const r1 = await manager.create({ cols: 80, rows: 24 });
    const r2 = await manager.create({ cols: 80, rows: 24 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.data).not.toBe(r2.data);
    }
  });

  it("stores session in internal Map", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(manager.getSession(result.data)).toBeDefined();
    }
  });

  it("returns error result when spawn fails", async () => {
    mockNodePty.spawn.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PTY_CREATE_FAILED");
    }
  });
});

describe("PtyManager kill", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("kills a session and removes it from Map", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.data;
    const session = manager.getSession(id) as MockIPty;
    const killSpy = vi.spyOn(session, "kill");
    manager.kill(id);
    expect(killSpy).toHaveBeenCalled();
    expect(manager.getSession(id)).toBeUndefined();
  });

  it("is a no-op for unknown session IDs", () => {
    expect(() => manager.kill("nonexistent-id")).not.toThrow();
  });
});

describe("PtyManager invalid shell", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.clearAllMocks();
  });

  it("returns PTY_CREATE_FAILED when shell does not exist", async () => {
    mockNodePty.spawn.mockImplementationOnce(() => {
      throw new Error("No such file or directory");
    });
    const result = await manager.create({ cols: 80, rows: 24, shell: "/nonexistent/shell" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PTY_CREATE_FAILED");
      expect(result.message).toBeTruthy();
    }
  });
});

describe("PtyManager kill nonexistent", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.clearAllMocks();
  });

  it("returns SESSION_NOT_FOUND when killing nonexistent session", () => {
    const result = manager.killSession("no-such-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_NOT_FOUND");
    }
  });
});

describe("PtyManager cleanup", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("kills all sessions on cleanup", async () => {
    const r1 = await manager.create({ cols: 80, rows: 24 });
    const r2 = await manager.create({ cols: 80, rows: 24 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const s1 = manager.getSession(r1.data) as MockIPty;
    const s2 = manager.getSession(r2.data) as MockIPty;
    const kill1 = vi.spyOn(s1, "kill");
    const kill2 = vi.spyOn(s2, "kill");

    manager.killAll();

    expect(kill1).toHaveBeenCalled();
    expect(kill2).toHaveBeenCalled();
    expect(manager.getSession(r1.data)).toBeUndefined();
    expect(manager.getSession(r2.data)).toBeUndefined();
  });
});

describe("PtyManager orphan", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.stopOrphanScan();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("removes exited (orphan) session after 30s scan", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.data;

    const pty = manager.getSession(id) as MockIPty;
    // Simulate process exit without kill() being called (orphan)
    pty.emitExit(0);

    manager.startOrphanScan();
    vi.advanceTimersByTime(30000);

    expect(manager.getSession(id)).toBeUndefined();
  });

  it("keeps alive sessions during orphan scan", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.data;

    manager.startOrphanScan();
    vi.advanceTimersByTime(30000);

    // Session is still alive (not exited) — should remain
    expect(manager.getSession(id)).toBeDefined();
  });
});
