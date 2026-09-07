# EZTerminal 1.0.51 validation policy and residual risk

## Release identity

- Desktop, Android and native-host version: `1.0.51`
- Android versionCode: `72`
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

Development validation covers Terminal launcher/model selection, empty Agent
creation without provider work, first-message dispatch, durable idle recovery,
pre-start settings, duplicate submission, legacy prompt recovery and desktop
Enter/Shift+Enter with IME protection. Desktop ordinary E2E, focused final-flow
E2E, desktop/mobile unit tests, production Storybook accessibility checks,
type checks, lint and the Android production web build passed before packaging.

Provider tests use fixtures; live paid-provider prompts, physical OEM behavior,
TalkBack and hardware keyboard variants are not certified by these local installer
checks. Windows remains unsigned. This functional-hotfix path performs no release
performance benchmark or lifecycle soak. Direct Taildrop delivery does not publish
a GitHub Release.
