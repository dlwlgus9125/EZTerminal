/**
 * Unit tests for FrameBuffer (T1 skeleton scope):
 * - push: accumulate data
 * - flush: 16ms coalescing window, triggers onFlush callback
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import FrameBuffer after test setup
const { FrameBuffer } = await import("../../src/main/frame-buffer");

describe("FrameBuffer coalesce", () => {
  let buffer: InstanceType<typeof FrameBuffer>;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new FrameBuffer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flush before 16ms", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);
    buffer.push("session-1", "hello");
    vi.advanceTimersByTime(10);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flushes coalesced data after 16ms", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);
    buffer.push("session-1", "hel");
    buffer.push("session-1", "lo");
    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledOnce();
    expect(onFlush).toHaveBeenCalledWith("session-1", "hello");
  });

  it("flushes each session independently", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);
    buffer.push("session-1", "foo");
    buffer.push("session-2", "bar");
    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledTimes(2);
    const calls = onFlush.mock.calls as [string, string][];
    const s1Call = calls.find((c) => c[0] === "session-1");
    const s2Call = calls.find((c) => c[0] === "session-2");
    expect(s1Call?.[1]).toBe("foo");
    expect(s2Call?.[1]).toBe("bar");
  });
});

describe("FrameBuffer flush", () => {
  let buffer: InstanceType<typeof FrameBuffer>;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new FrameBuffer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a new timer after flush", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);
    buffer.push("session-1", "first");
    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledOnce();

    buffer.push("session-1", "second");
    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledTimes(2);
    const calls = onFlush.mock.calls as [string, string][];
    expect(calls[1]?.[1]).toBe("second");
  });

  it("only fires once per push batch regardless of multiple pushes", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);
    buffer.push("session-1", "a");
    buffer.push("session-1", "b");
    buffer.push("session-1", "c");
    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledOnce();
    const calls = onFlush.mock.calls as [string, string][];
    expect(calls[0]?.[1]).toBe("abc");
  });
});
