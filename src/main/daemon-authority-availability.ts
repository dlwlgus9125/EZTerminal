import {
  DAEMON_DATABASE_SCHEMA_VERSION,
  type DaemonAuthorityAvailability,
} from '../shared/daemon-authority';
import { DaemonStoreInitializationError } from './daemon-store';

export function readyDaemonAuthorityAvailability(): DaemonAuthorityAvailability {
  return {
    state: 'ready',
    supportedSchemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
    currentSchemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
  };
}

export function safeModeDaemonAuthorityAvailability(
  error: unknown,
): DaemonAuthorityAvailability {
  if (error instanceof DaemonStoreInitializationError) {
    return {
      state: 'legacy-only-safe-mode',
      initializationCode: error.code,
      databaseDisposition: error.databaseDisposition,
      supportedSchemaVersion: error.supportedSchemaVersion,
      ...(error.schemaVersion === undefined ? {} : { currentSchemaVersion: error.schemaVersion }),
      ...(error.recoveryPath === undefined ? {} : { recoveryPath: error.recoveryPath }),
    };
  }
  return {
    state: 'legacy-only-safe-mode',
    initializationCode: 'initialization-failed',
    databaseDisposition: 'preserved',
    supportedSchemaVersion: DAEMON_DATABASE_SCHEMA_VERSION,
  };
}
