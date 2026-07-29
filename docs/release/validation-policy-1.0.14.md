# EZTerminal 1.0.14 validation policy and residual risk

## Release identity

- Desktop, Android, and native-host product version: `1.0.14`
- Android versionCode: `35`
- Remote client protocol: `5`
- Electron-to-Rust native desktop-host protocol: `2`
- Validation profile: `full`

The shipped remote protocol is v5.

The tagged 1.0.13 identity and its protocol-v3 documentation are immutable.
The version verifier rejects reuse of an existing tag with changed version,
versionCode, protocol, or validation profile.

## Required non-performance gates

The exact candidate SHA must have a clean tree and pass:

- frozen dependency install, version contract, desktop/mobile typecheck and
  lint, three consecutive zero-retry unit/OS runs, and dependency audits;
- Storybook interaction, production build, product-component visual snapshots,
  axe checks, Korean/English, supported widths, 150% scale, high contrast, and
  reduced motion;
- Rust format, unit, clippy, audit, deny, and native-host build;
- ordinary `pnpm e2e`, native guards, packaged Electron smoke, and exact-SHA
  Windows packaging;
- Android lint, unit and instrumentation plus API 29/API 35 cold-boot smoke,
  QR-scanner lifecycle checks, stabilization, parity, theme/effects,
  handoff-surface validation, and the API 35 functional soak;
- production mobile asset restoration, E2E-marker rejection, signed APK
  identity/certificate/build-SHA verification, SBOM, manifest, and checksums.

The approval-privacy and offline-pairing guards are mandatory in ordinary CI,
the local candidate, and the final release workflow.

## Candidate versus final release

The local candidate report uses schema v2 and records:

```json
{
  "releaseStage": "candidate",
  "desktopPerformance": {
    "status": "pending-final-release-measurement",
    "reason": "not-requested-for-this-local-rc"
  }
}
```

Candidate artifacts are staged in a version-and-SHA-specific directory, carry
`publicationEligible=false`, and must not read or copy an older performance
report. The final release workflow rejects this pending status and requires a
same-host, exact-SHA, schema-v2 passing performance comparison. Release staging
requires an explicit performance measurement, complete passing evidence, a
clean tree, and the exact HEAD SHA frozen at validation start.

Ordinary build, test, package, update, RC, or release requests do not authorize
`pnpm e2e:performance`, `e2e/release-performance.spec.ts`,
`EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`,
`EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC=1`, or
`-RunPerformanceMeasurement`.

## Protected approval evidence

The protected GitHub Environment `release` binds final approval to:

- variable `EZTERMINAL_LOCAL_RC_APPROVED_SHA`
- variable `EZTERMINAL_LOCAL_RC_REPORT_SHA256`
- variable `EZTERMINAL_LOCAL_RC_EVIDENCE_SHA256`
- secret `EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64`

The evidence ZIP contains exactly:

- `local-rc-report.json`
- `mobile-soak-report.json`
- `desktop-performance-baseline.json`
- `desktop-performance-report.json`

The workflow verifies the encoded bundle before extracting it into a new
temporary directory. It rejects nested paths, unexpected or duplicate entries,
unsafe file types, invalid numbers, mismatched source hashes, incomplete soak
results, and a failed baseline-versus-candidate comparison.

Pending candidate evidence is never publication-eligible. Only a complete
`release` report produced after an explicitly authorized performance
measurement, with performance status `passed`, can enter release staging.

All validation and build jobs use `contents: read`, and every checkout disables
credential persistence. Only the tag-only publish job receives
`contents: write`. It downloads the immutable build-job artifact and
revalidates the manifest, checksums, exact SHA, and publication eligibility
before creating a draft release.

## Compatibility

- A v5 host accepts supported v1/v2/v3/v4/v5 clients and exposes capabilities
  according to the negotiated version.
- v3 adds Agent Attention, Git review, pairing presence, and correlated RTT;
  v4 adds paged Agent history; v5 adds project management and new-chat
  launchers.
- A v5 mobile client with an already stored bearer may retry once at the
  highest lower version advertised by an authenticated incompatibility reply.
- Invalid tokens, malformed replies, naked connection closes, and upward
  versions never trigger downgrade.
- One-time QR pairing requires v3 or later. Older fallback provides only the
  capabilities defined by that protocol version.

## Known limits and residual risk

- Lock and UAC secure-desktop capture and input are unsupported.
- Software SAS and Ctrl+Alt+Delete are unsupported.
- GDI capture, OpenH264 encoding, and SendInput injection remain in the
  normal-user transport.
- Windows 10/Home/Enterprise, domain/MDM policy, elevated service lifecycle,
  physical Android/OEM camera, TalkBack, hardware keyboard, HDR, multi-monitor,
  and adverse physical-network paths are not fully automated by the local
  emulator candidate.
- OpenClaw's external WebContentsView content is not a pixel oracle;
  EZTerminal chrome and loading/stopped/error states are.
- Final publication remains blocked until the separately authorized
  performance measurement passes for the exact candidate SHA.
