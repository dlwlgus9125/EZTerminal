# SignPath Windows release setup

Public Windows artifacts use the SignPath Foundation open-source certificate.
The publisher shown by Windows is `SignPath Foundation`, not an individual or
the EZTerminal product name. A valid signature removes the "unknown publisher"
condition, but Microsoft Defender SmartScreen can still warn while a new file
or certificate is building reputation; Microsoft publishes no fixed download
count or waiting period.

## One-time SignPath configuration

1. Apply for a free open-source project at
   [SignPath Foundation](https://signpath.org/apply). Link this repository,
   [the code signing policy](../../CODE_SIGNING_POLICY.md), and
   [the privacy policy](../../PRIVACY.md).
2. Enable multi-factor authentication for every GitHub and SignPath account in
   a listed project role.
3. Configure GitHub as the trusted build system for this repository and select
   the GitHub-hosted `Release` workflow as the permitted origin.
4. Create a manual-approval signing policy using the SignPath Foundation
   certificate and RFC 3161 timestamping.
5. Create two artifact configurations by importing the committed files:

   - `.signpath/windows-payload.xml`
   - `.signpath/windows-installer.xml`

6. In the protected GitHub Environment named `release`, add secret
   `SIGNPATH_API_TOKEN` for a SignPath submitter and these environment
   variables:

   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
   - `SIGNPATH_WINDOWS_PAYLOAD_CONFIGURATION_SLUG`
   - `SIGNPATH_WINDOWS_INSTALLER_CONFIGURATION_SLUG`

The SignPath token submits requests but does not approve them. Keep submitter
and approval responsibility distinct where the project gains additional
maintainers. If the application is rejected for the free certificate, do not
substitute an unreviewed certificate or silently publish an unsigned build;
the current release workflow is intentionally blocked. Microsoft Store
publication is not a fallback in this policy.

## Per-release flow

The workflow performs the following fail-closed sequence:

1. Build the package locally on `windows-2022` and verify all first-party files
   are unsigned with matching `ProductName` and `ProductVersion` metadata.
2. Submit `EZTerminal.exe`, `ezterminal-remote-host.exe`, and the generated
   `Uninstall EZTerminal.exe` as one exact ZIP payload. An approver accepts the
   first signing request.
3. Verify publisher, timestamp, certificate hashes, versions, filenames, and
   exact file count. Rebuild NSIS with the signed uninstaller embedded.
4. Submit only `EZTerminal-Setup.exe`. An approver accepts the second signing
   request.
5. Verify all four signatures, silently install into runner temporary storage,
   verify the three installed first-party executables, uninstall, and then
   stage the release manifest and checksums.
6. The separate publication job redownloads the immutable artifact and again
   verifies the setup signature and manifest evidence before creating a draft
   GitHub Release.

Any missing approval, changed filename, extra file, invalid signature, wrong
publisher, absent timestamp, metadata mismatch, or hash mismatch stops the
release. Local `pnpm make` and local RC commands remain unsigned and cannot be
published by the protected workflow.

The action integration follows the official
[SignPath GitHub trusted-build documentation](https://docs.signpath.io/trusted-build-systems/github).
