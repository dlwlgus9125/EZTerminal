# SignPath Windows release setup

After approval, public Windows artifacts use the SignPath Foundation
open-source certificate. The publisher shown by Windows is `SignPath
Foundation`, not an individual or the EZTerminal product name. A valid
signature removes the "unknown publisher" condition, but Microsoft Defender
SmartScreen can still warn while a new file or certificate is building
reputation; Microsoft publishes no fixed download count or waiting period.

While the application is pending, `release/version.json` explicitly selects
`windowsSigningMode: "unsigned"`. The release workflow then accepts only a
completely absent SignPath configuration and publishes verified `NotSigned`
maintenance installers. Those installers still produce Windows' unknown-
publisher warning.

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
maintainers.

After all six GitHub values are present, change `windowsSigningMode` from
`unsigned` to `signpath` in a reviewed release commit before running the
workflow. In unsigned mode, even one present SignPath value is an error. In
signpath mode, even one missing value is an error. A failed request never falls
back to an unsigned artifact. If the application is rejected, keep the
explicit unsigned policy or revise the distribution policy in a separate
reviewed change; Microsoft Store publication is not an automatic fallback.

## Signed per-release flow

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

## Pending-approval maintenance flow

With `windowsSigningMode: "unsigned"` and no SignPath values configured, the
same workflow builds the four first-party Windows executables, verifies each is
`NotSigned`, performs the packaged and silent-install checks, and records
component hashes in `release-manifest.json` and `SHA256SUMS.txt`. The SignPath
upload and request steps are skipped. Tag builds can create the same draft
GitHub Release as the signed path.

The application may check GitHub Releases at startup, but it does not download
or install automatically. The user must choose Download, choose Open installer,
and acknowledge the additional unsigned-installer warning. This integrity
checking does not suppress the Windows unknown-publisher or SmartScreen UI.

The action integration follows the official
[SignPath GitHub trusted-build documentation](https://docs.signpath.io/trusted-build-systems/github).
