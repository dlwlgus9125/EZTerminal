import { describe, expect, it } from 'vitest';

import { redactDaemonAuthorityAvailability } from '../shared/daemon-authority';
import { DaemonStoreInitializationError } from './daemon-store';
import {
  readyDaemonAuthorityAvailability,
  safeModeDaemonAuthorityAvailability,
} from './daemon-authority-availability';

describe('daemon authority availability', () => {
  it('serializes a quarantined corrupt database with its trusted Desktop recovery path', () => {
    const availability = safeModeDaemonAuthorityAvailability(new DaemonStoreInitializationError(
      'database-corrupt',
      'integrity check failed',
      {
        databaseDisposition: 'quarantined',
        recoveryPath: 'C:\\Users\\test\\daemon-recovery\\set-1',
        schemaVersion: 3,
      },
    ));

    expect(JSON.parse(JSON.stringify(availability))).toEqual({
      state: 'legacy-only-safe-mode',
      initializationCode: 'database-corrupt',
      databaseDisposition: 'quarantined',
      supportedSchemaVersion: 3,
      currentSchemaVersion: 3,
      recoveryPath: 'C:\\Users\\test\\daemon-recovery\\set-1',
    });
    expect(redactDaemonAuthorityAvailability(availability)).not.toHaveProperty('recoveryPath');
  });

  it('reports a future schema as preserved and leaves the ready path unchanged', () => {
    expect(safeModeDaemonAuthorityAvailability(new DaemonStoreInitializationError(
      'future-schema',
      'newer schema',
      { databaseDisposition: 'preserved', schemaVersion: 9 },
    ))).toEqual({
      state: 'legacy-only-safe-mode',
      initializationCode: 'future-schema',
      databaseDisposition: 'preserved',
      supportedSchemaVersion: 3,
      currentSchemaVersion: 9,
    });
    expect(readyDaemonAuthorityAvailability()).toEqual({
      state: 'ready',
      supportedSchemaVersion: 3,
      currentSchemaVersion: 3,
    });
  });
});
