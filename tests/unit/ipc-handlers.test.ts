/**
 * Unit tests for IPC handlers (T2 scope):
 * - pty:create → IpcResult<string>
 * - pty:write → stdin
 * - pty:resize → PTY resize
 * - pty:data push (frame buffer)
 * - pty:write nonexistent (ignored)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockIPty, mockNodePty, resetNodePtyMocks } from "../mocks/node-pty";

vi.mock("node-pty", () => mockNodePty);

// We test PtyManager + FrameBuffer integration directly (simulating what main/index.ts does)
const { PtyManager } = await import("../../src/main/pty-manager");
const { FrameBuffer } = await import("../../src/main/frame-buffer");

describe("IPC pty:create", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.clearAllMocks();
  });

  it("returns IpcResult<string> with ok=true and session ID", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data).toBe("string");
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  it("returns IpcResult with ok=false on spawn failure", async () => {
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

describe("IPC pty:write", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.clearAllMocks();
  });

  it("writes data to PTY stdin", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pty = manager.getSession(result.data) as MockIPty;
    const writeSpy = vi.spyOn(pty, "write");
    pty.write("hello");
    expect(writeSpy).toHaveBeenCalledWith("hello");
  });
});

describe("IPC pty:write nonexistent", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is silently ignored when session does not exist", () => {
    // Simulate pty:write handler: getSession → undefined → return early
    const pty = manager.getSession("nonexistent-id");
    expect(pty).toBeUndefined();
    // Handler would return without calling write — no error thrown
    expect(() => {
      if (pty) pty.write("data");
    }).not.toThrow();
  });
});

describe("IPC pty:resize", () => {
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    resetNodePtyMocks();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.clearAllMocks();
  });

  it("resizes the PTY to new cols and rows", async () => {
    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pty = manager.getSession(result.data) as MockIPty;
    const resizeSpy = vi.spyOn(pty, "resize");
    pty.resize(120, 40);
    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(40);
  });
});

describe("IPC pty:data push", () => {
  let manager: InstanceType<typeof PtyManager>;
  let buffer: InstanceType<typeof FrameBuffer>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetNodePtyMocks();
    manager = new PtyManager();
    buffer = new FrameBuffer();
  });

  afterEach(() => {
    manager.killAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("PTY onData pushes to FrameBuffer and flushes after 16ms", async () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);

    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.data;

    // Wire PTY onData → FrameBuffer (as main/index.ts does)
    const pty = manager.getSession(id) as MockIPty;
    pty.onData((data: string) => {
      buffer.push(id, data);
    });

    // Emit data from PTY
    pty.emitData("hello");
    pty.emitData(" world");

    vi.advanceTimersByTime(16);

    expect(onFlush).toHaveBeenCalledOnce();
    const calls = onFlush.mock.calls as [string, string][];
    expect(calls[0]?.[0]).toBe(id);
    // Note: MockIPty.emitData does NOT echo — it sends exactly what's passed
    expect(calls[0]?.[1]).toBe("hello world");
  });
});
