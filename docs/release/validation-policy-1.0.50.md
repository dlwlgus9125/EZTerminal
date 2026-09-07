# EZTerminal 1.0.50 validation policy and residual risk

## Release identity

- Desktop, Android and native-host version: `1.0.50`
- Android versionCode: `71`
- Remote protocol: `v12`
- Electron-to-Rust native desktop protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing tags and versioned release documents remain immutable. The requested
local installers are built from one exact clean Git SHA using
`scripts/build-local-release-candidate.ps1 -InstallersOnly`.

## Local installer checks

The build checks version, documentation and Project Map contracts, packages the
Windows app and NSIS installer, verifies their unsigned identity and runs packaged
Electron smoke. Android uses production web assets, lint and unit checks, and the
existing protected long-term signing key. APK verification checks the application
ID, version, SDK bounds, certificate, production markers and embedded source SHA.

Both installers, the SBOM, checksums and a `local-build-receipt.json` are staged
in an isolated directory. The receipt records `publicationEligible=false`; it
does not certify the full release workflow. Signing credentials remain confined
to the ephemeral signing child and are never printed or stored in plaintext.

## Functional coverage and limits

Terminal-first entry, explicit CLI and app-chat selection, optional settings,
original transcript content, database migration, streaming identity and Android
view restoration have regression coverage. Desktop E2E includes an older CLI
fixture that launches with app chat unavailable. Responsive/accessibility checks
cover narrow widths and 150% scale. Android emulator checks cover ordinary and
xterm input/output plus automatic restoration after force-stop.

Live paid-provider prompts, physical OEM behavior, TalkBack and hardware keyboard
variants are not certified by these local installer checks. Windows remains
unsigned. Already-redacted historical transcripts cannot be reconstructed. This
functional-hotfix path performs no release performance benchmark or lifecycle
soak. Public release publication requires the existing formal workflow and its
own approval; direct Taildrop delivery does not publish a GitHub Release.
