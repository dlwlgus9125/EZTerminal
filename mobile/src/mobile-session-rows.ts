import type { SessionInfo } from '../../src/shared/ipc';

/** A terminal session as the phone lists it, with whether it is open in a tab. */
export interface HomeSessionRow {
  readonly session: SessionInfo;
  readonly open: boolean;
}
