# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Official Windows releases are built from this public repository by the
GitHub-hosted `Release` workflow. While the SignPath Foundation application is
pending, the committed `release/version.json` contract may select
`windowsSigningMode: "unsigned"`. In that mode the workflow permits a public
maintenance release only when all SignPath settings are absent, verifies that
all four first-party Windows executables are unsigned, and records their file
hashes and `NotSigned` status in the release manifest. Windows will continue to
show an unknown-publisher warning for those installers.

When the committed mode is `signpath`, the workflow submits only EZTerminal's
own binaries for Authenticode signing and records the two SignPath
signing-request IDs, file hashes, publisher, certificate hashes, and timestamp
evidence in the release manifest. Third-party executables included with
Electron dependencies are not submitted under the EZTerminal signing
configuration.

## Team roles

- Committer and reviewer: [@dlwlgus9125](https://github.com/dlwlgus9125)
- Signing approver: [@dlwlgus9125](https://github.com/dlwlgus9125)

All people in these roles must use multi-factor authentication for GitHub and
SignPath. Every signing request requires manual approval. A release requires
one approval for the application payload and another for the final NSIS
installer; automation may not bypass either approval.

The signed publisher is exactly `SignPath Foundation`. Local builds and local
release candidates remain unsigned and are not official distribution
artifacts. Public unsigned maintenance releases require the explicit committed
mode above; they retain SHA-256 verification and require users to choose both
download and installer launch. The app also requires a second confirmation
before opening an unsigned installer. It never downloads or installs an update
in the background.

There is no automatic fallback from a configured SignPath release to an
unsigned release. Partial SignPath configuration fails before packaging, and
any signing request, approval, signature, publisher, timestamp, or evidence
failure stops the release. After approval, changing the committed mode to
`signpath` makes complete SignPath configuration and valid signatures
mandatory for subsequent releases. Any later decision to return to unsigned
publication requires a separate reviewed policy change.

See the [privacy policy](PRIVACY.md) and the
[SignPath release setup](docs/release/signpath-setup.md).
