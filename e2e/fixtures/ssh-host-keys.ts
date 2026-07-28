// Non-secret, test-only OpenSSH host keys. Keeping these fixtures fixed makes the
// SSH E2E suites deterministic and avoids ssh2@1.17.0's flaky Ed25519 key
// serializer, which can drop a significant leading zero byte from a generated
// public key. These keys protect no real system or credential.
export const SSH_HOST_KEY_A = Buffer.from(
  `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACAj0omlhMqIYFchcpDNHKYz2zDWNwI4anyHjOclvjSHMAAA
AIjdzDks3cw5LAAAAAtzc2gtZWQyNTUxOQAAACAj0omlhMqIYFchcpDNHKYz2zDW
NwI4anyHjOclvjSHMAAAAEDnW25ZZBrY3211tuXBtPol2L7DhMiI30Fnfv/PyqF+
8SPSiaWEyohgVyFykM0cpjPbMNY3AjhqfIeM5yW+NIcwAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`,
);

export const SSH_HOST_KEY_B = Buffer.from(
  `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACCbCclvOwJpIQowHx15fFsRntL98aB/41V80NWAbV38nAAA
AIiC60zkgutM5AAAAAtzc2gtZWQyNTUxOQAAACCbCclvOwJpIQowHx15fFsRntL9
8aB/41V80NWAbV38nAAAAEDEJdS4AfOxVM5/hmpgCk2DidGv+DduX3phKei69gY8
DpsJyW87AmkhCjAfHXl8WxGe0v3xoH/jVXzQ1YBtXfycAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`,
);
