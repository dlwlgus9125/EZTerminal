/** SQLite schema understood by this build's structured Agent authority. */
export const DAEMON_DATABASE_SCHEMA_VERSION = 3;

/** Stable initialization outcomes suitable for IPC and remote serialization. */
export type DaemonAuthorityInitializationFailureCode =
  | 'backup-failed'
  | 'database-corrupt'
  | 'future-schema'
  | 'initialization-failed'
  | 'migration-failed'
  | 'quarantine-failed'
  | 'unsafe-path';

export type DaemonAuthorityDatabaseDisposition =
  | 'preserved'
  | 'quarantined'
  | 'partial-quarantine';

export interface DaemonAuthorityReadyAvailability {
  readonly state: 'ready';
  readonly supportedSchemaVersion: number;
  readonly currentSchemaVersion: number;
}

export interface DaemonAuthoritySafeModeAvailability {
  readonly state: 'legacy-only-safe-mode';
  readonly initializationCode: DaemonAuthorityInitializationFailureCode;
  readonly databaseDisposition: DaemonAuthorityDatabaseDisposition;
  readonly supportedSchemaVersion: number;
  readonly currentSchemaVersion?: number;
  /** Trusted Desktop only. Remote transports must use the redacted type below. */
  readonly recoveryPath?: string;
}

/** Latched process-lifetime truth for structured Agent authority availability. */
export type DaemonAuthorityAvailability =
  | DaemonAuthorityReadyAvailability
  | DaemonAuthoritySafeModeAvailability;

/** Remote-safe form deliberately cannot carry a local filesystem path. */
export type RemoteDaemonAuthorityAvailability =
  | DaemonAuthorityReadyAvailability
  | Omit<DaemonAuthoritySafeModeAvailability, 'recoveryPath'>;

export function redactDaemonAuthorityAvailability(
  availability: DaemonAuthorityAvailability,
): RemoteDaemonAuthorityAvailability {
  if (availability.state === 'ready') return availability;
  return {
    state: availability.state,
    initializationCode: availability.initializationCode,
    databaseDisposition: availability.databaseDisposition,
    supportedSchemaVersion: availability.supportedSchemaVersion,
    ...(availability.currentSchemaVersion === undefined
      ? {}
      : { currentSchemaVersion: availability.currentSchemaVersion }),
  };
}
