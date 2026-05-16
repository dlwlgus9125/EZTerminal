/**
 * Unit tests for FrameBuffer (T1+T2 scope):
 * - push: accumulate data
 * - flush: 16ms coalescing window, triggers onFlush callback
 * - per-session independence
 * - cleanup: session end discards buffered data
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

describe("FrameBuffer per-session", () => {
  let buffer: InstanceType<typeof FrameBuffer>;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new FrameBuffer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes session-1 and session-2 independently with separate data", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);
    buffer.push("session-1", "AAA");
    buffer.push("session-2", "BBB");
    buffer.push("session-1", "CCC");

    vi.advanceTimersByTime(16);

    const calls = onFlush.mock.calls as [string, string][];
    const s1 = calls.find((c) => c[0] === "session-1");
    const s2 = calls.find((c) => c[0] === "session-2");
    expect(s1?.[1]).toBe("AAACCC");
    expect(s2?.[1]).toBe("BBB");
  });

  it("one session's timer does not affect another's flush timing", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);

    buffer.push("session-1", "early");
    vi.advanceTimersByTime(8);
    buffer.push("session-2", "late");

    // After 16ms from start: session-1 flushes, session-2 not yet
    vi.advanceTimersByTime(8);
    const calls1 = (onFlush.mock.calls as [string, string][]).filter((c) => c[0] === "session-1");
    const calls2 = (onFlush.mock.calls as [string, string][]).filter((c) => c[0] === "session-2");
    expect(calls1.length).toBe(1);
    expect(calls2.length).toBe(0);

    // After another 8ms: session-2 flushes
    vi.advanceTimersByTime(8);
    const calls2After = (onFlush.mock.calls as [string, string][]).filter(
      (c) => c[0] === "session-2"
    );
    expect(calls2After.length).toBe(1);
  });
});

describe("FrameBuffer cleanup", () => {
  let buffer: InstanceType<typeof FrameBuffer>;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new FrameBuffer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("discards buffered data when session ends before flush", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);

    buffer.push("session-1", "data that should be discarded");
    // End session before 16ms elapses
    buffer.endSession("session-1");

    vi.advanceTimersByTime(16);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("does not affect other sessions when one session ends", () => {
    const onFlush = vi.fn();
    buffer.onFlush(onFlush);

    buffer.push("session-1", "keep");
    buffer.push("session-2", "discard");
    buffer.endSession("session-2");

    vi.advanceTimersByTime(16);

    const calls = onFlush.mock.calls as [string, string][];
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("session-1");
    expect(calls[0]?.[1]).toBe("keep");
  });
});
