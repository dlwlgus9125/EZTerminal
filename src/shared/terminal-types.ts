/**
 * Shared terminal/PTY type definitions.
 */

export interface PtyCreateOptions {
  cols: number;
  rows: number;
  shell?: string;
}

export interface PtySession {
  id: string;
  pid: number;
  cols: number;
  rows: number;
}
