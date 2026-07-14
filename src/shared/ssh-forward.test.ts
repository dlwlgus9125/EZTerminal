import { describe, expect, it } from 'vitest';

import {
  SshForwardError,
  validateSshConnectionId,
  validateSshForwardAction,
  validateSshRemoteHost,
} from './ssh-forward';

describe('SSH forward input validation', () => {
  it.each(['db.internal', '127.0.0.1', '2001:db8::1'])('accepts a bounded DNS/IP destination: %s', (host) => {
    expect(() => validateSshRemoteHost(host)).not.toThrow();
  });

  it.each(['', 'bad host', 'user@host', '../socket', '01.2.3.4', '999.2.3.4', 'gggg::1', ':::'])('rejects an unsafe destination: %s', (host) => {
    expect(() => validateSshRemoteHost(host)).toThrow(SshForwardError);
  });

  it('uses stable error codes for malformed ids and ports', () => {
    expect(() => validateSshConnectionId('../connection')).toThrow(expect.objectContaining({ code: 'INVALID_CONNECTION_ID' }));
    expect(() => validateSshForwardAction({
      action: 'start', connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 0, localPort: 0,
    })).toThrow(expect.objectContaining({ code: 'INVALID_REMOTE_PORT' }));
    expect(() => validateSshForwardAction({
      action: 'start', connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: -1,
    })).toThrow(expect.objectContaining({ code: 'INVALID_LOCAL_PORT' }));
  });
});
