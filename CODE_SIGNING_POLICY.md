# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Official Windows releases are built from this public repository by the
GitHub-hosted `Release` workflow. The workflow submits only EZTerminal's own
binaries for Authenticode signing and records the two SignPath signing-request
IDs, file hashes, publisher, certificate hashes, and timestamp evidence in the
release manifest. Third-party executables included with Electron dependencies
are not submitted under the EZTerminal signing configuration.

## Team roles

- Committer and reviewer: [@dlwlgus9125](https://github.com/dlwlgus9125)
- Signing approver: [@dlwlgus9125](https://github.com/dlwlgus9125)

All people in these roles must use multi-factor authentication for GitHub and
SignPath. Every signing request requires manual approval. A release requires
one approval for the application payload and another for the final NSIS
installer; automation may not bypass either approval.

The signed publisher is exactly `SignPath Foundation`. Local builds and local
release candidates remain unsigned and are not official distribution
artifacts. If SignPath Foundation does not accept or can no longer sign this
project, Windows publication stops until this policy is explicitly revised.

See the [privacy policy](PRIVACY.md) and the
[SignPath release setup](docs/release/signpath-setup.md).
