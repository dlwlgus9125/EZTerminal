# EZTerminal 1.0.49 validation policy and residual risk

## Release identity

- Desktop, Android and native-host version: `1.0.49`
- Android versionCode: `70`
- Remote protocol: `v12`
- Electron-to-Rust native desktop protocol: `v2`
- Validation profile: `functional-hotfix`
- Windows signing mode: `unsigned`

Existing release tags and versioned documents remain immutable. New installers
are built from one exact clean local Git SHA. Pushing, tagging, publishing or
promoting a GitHub Release requires separate approval.

## Local installer build

`scripts/build-local-release-candidate.ps1 -InstallersOnly` is an explicit local
packaging path, separate from full RC certification and the GitHub release job.
It checks the version contract, builds the Windows payload and NSIS installer,
verifies their unsigned state, runs packaged Electron smoke, builds production
mobile assets, runs Android lint/unit validation, and assembles the APK using
the existing protected release key. APK verification checks its application ID,
version, SDK bounds, certificate, production markers and embedded source SHA.

The output directory contains both installers, an SBOM, a
`local-build-receipt.json` and `SHA256SUMS.txt`. The receipt must say
`publicationEligible=false`. It reports only the checks actually run and does
not claim full RC, emulator/device, performance or soak completion. Credentials
are decrypted only for the isolated signing child and are never printed or
written in plaintext. Source drift prevents signing or final staging.

## Functional coverage and formal release gates

New Session coverage checks both kinds and Agent modes, unavailable providers,
invalid locations, duplicate-submit guards, and the selected Workspace identity.
Terminal coverage checks view detachment, live input/output reattachment,
completed-output restoration, and separate guarded termination. Responsive and
accessibility checks cover desktop window controls, Korean/English choices and
mobile project-list touch scrolling.

Before a formal release, the exact candidate SHA must pass the existing version,
documentation, Project Map, dependency audit, desktop/mobile type/lint/test,
Storybook, visual/accessibility, ordinary zero-retry E2E, Rust, native, packaged,
Android, signing, SBOM, manifest and checksum gates. Local installer receipts do
not replace those workflow results. The functional-hotfix profile runs no release
performance benchmark or lifecycle soak and makes no such claim.

## Residual limits

- Provider execution still requires compatible installed CLIs and user-owned
  authentication. Tests do not submit paid live-provider prompts.
- Closed-view drafts and completed-run descriptors are process-local, not a
  new persisted archive. Existing SSH late-attach restrictions remain.
- Physical Android/OEM behavior, TalkBack, hardware keyboards, Windows policy
  variants and live network conditions require separate device validation.
- Windows is unsigned; verify the artifact checksum before opening it.
- Both clients should be updated together for the new detach behavior, although
  the shared remote protocol version remains v12.
