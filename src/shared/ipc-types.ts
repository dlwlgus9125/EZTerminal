/**
 * Shared IPC type definitions used across main, preload, and renderer.
 * IpcResult<T> pattern: discriminated union for all IPC responses.
 */

export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
