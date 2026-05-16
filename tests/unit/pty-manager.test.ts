/**
 * Unit tests for PtyManager (T1 skeleton scope):
 * - create: spawn PTY, return IpcResult<string> with session ID
 * - kill: terminate PTY, remove from Map
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
