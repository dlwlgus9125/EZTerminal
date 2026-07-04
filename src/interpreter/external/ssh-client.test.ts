import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { utils as ssh2Utils } from 'ssh2';

import { hostKeyFingerprint, hostKeyType, parsePrivateKey } from './ssh-client';

// Fixture keys generated once via ssh2's own utils.generateKeyPair('ed25519', ...)
// so parsePrivateKey is exercised against REAL ssh2 error text (NEEDS-INSTALL-VERIFY
// resolved — see the gate record) rather than a guessed format.
const PLAIN_KEY = Buffer.from(
  `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACAj0omlhMqIYFchcpDNHKYz2zDWNwI4anyHjOclvjSHMAAA
AIjdzDks3cw5LAAAAAtzc2gtZWQyNTUxOQAAACAj0omlhMqIYFchcpDNHKYz2zDW
NwI4anyHjOclvjSHMAAAAEDnW25ZZBrY3211tuXBtPol2L7DhMiI30Fnfv/PyqF+
8SPSiaWEyohgVyFykM0cpjPbMNY3AjhqfIeM5yW+NIcwAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`,
);

const ENCRYPTED_KEY = Buffer.from(
  `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAK
1Lp2GcF2ecKSLUhRkc/iAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIKU5
imvA0yNc6mq6EPmUOyzCL94Ar75KurKSGlQmrCaxAAAAkP3eDLJHv5Ll3DYRmEDO
0UZItATHZ9cmHzNMi0IZwZuUPC5QtvqW2TpO8U5QE8+m/T/ldEdooSbDK22ncUmC
I+g2N22ohmTQYuJm2u7XcZT14e1X6YKr8FvRK3tUVSeP2hTP+qtOTQO100vFhLO8
SUj58q8kV+L4F1jemkrdaWht3+7cfO9qco+38rOKlZiFSQ==
-----END OPENSSH PRIVATE KEY-----
`,
);
const ENCRYPTED_KEY_PASSPHRASE = 'testpass123';

function rawHostKey(): Buffer {
  const parsed = ssh2Utils.parseKey(PLAIN_KEY);
  if (parsed instanceof Error) throw parsed;
  return parsed.getPublicSSH();
}

describe('hostKeyFingerprint', () => {
  it('is the OpenSSH SHA256:<base64, no padding> form of the raw key bytes', () => {
    const key = rawHostKey();
    const expected = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    expect(hostKeyFingerprint(key)).toBe(expected);
  });

  it('never contains base64 padding (=)', () => {
    expect(hostKeyFingerprint(rawHostKey())).not.toContain('=');
  });

  it('is deterministic for the same key bytes', () => {
    const key = rawHostKey();
    expect(hostKeyFingerprint(key)).toBe(hostKeyFingerprint(Buffer.from(key)));
  });

  it('differs for different key bytes', () => {
    const key = rawHostKey();
    const mutated = Buffer.from(key);
    mutated[0] ^= 0xff;
    expect(hostKeyFingerprint(key)).not.toBe(hostKeyFingerprint(mutated));
  });
});

describe('hostKeyType', () => {
  it("parses the real key type ('ssh-ed25519') from the raw key blob", () => {
    expect(hostKeyType(rawHostKey())).toBe('ssh-ed25519');
  });

  it("falls back to 'unknown' for a blob that isn't a valid key", () => {
    expect(hostKeyType(Buffer.from('not a key'))).toBe('unknown');
  });
});

describe('parsePrivateKey', () => {
  it('accepts an unencrypted key with no passphrase', () => {
    expect(parsePrivateKey(PLAIN_KEY)).toEqual({ ok: true });
  });

  it('accepts an encrypted key with the CORRECT passphrase', () => {
    expect(parsePrivateKey(ENCRYPTED_KEY, ENCRYPTED_KEY_PASSPHRASE)).toEqual({ ok: true });
  });

  it("reports reason:'encrypted' for an encrypted key with NO passphrase (prompt trigger)", () => {
    const result = parsePrivateKey(ENCRYPTED_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('encrypted');
  });

  it("reports reason:'encrypted' for an encrypted key with the WRONG passphrase (same retry path)", () => {
    const result = parsePrivateKey(ENCRYPTED_KEY, 'definitely-wrong');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('encrypted');
  });

  it("reports reason:'invalid' for bytes that are not a private key at all", () => {
    const result = parsePrivateKey(Buffer.from('not a key'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });
});
