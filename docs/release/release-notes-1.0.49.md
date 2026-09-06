# EZTerminal 1.0.49

Release identity: remote protocol v12, Android versionCode 70.

This version restores a clear New Session flow on desktop and Android:

- Choose Agent or a regular Terminal. Agent sessions then offer an in-app
  conversation or the provider's terminal CLI.
- Navigate Project → Workspace → Session, including live terminals. Standalone
  terminals and previous provider-native CLI history remain available.
- Close a view without stopping its work. Reopening the same session restores
  output, completed blocks, drafts and view metadata within the current process.
- End a terminal through a separate confirmation that rechecks its live runs.

The header preserves quick Terminal access and usable controls at narrow widths
and 150% scale. Existing theme tokens, provider consent/review, CLI launch
validation, SSH late-attach limitations and main-window quit/tray behavior remain
unchanged. Desktop and Android should be upgraded together.

## Artifacts and publication status

- Windows 10 22H2 / Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 / API 29 or newer: `EZTerminal-Android-1.0.49-vc70.apk`

Windows remains Authenticode `NotSigned` while SignPath approval is pending;
an unknown-publisher warning is expected. Android uses the existing long-term
release certificate, not a debug or replacement key.

The requested local installer build is not a published or publication-approved
release. Its `local-build-receipt.json` records the exact source commit, actual
artifact verification and SHA-256 hashes. It must not be substituted for the
formal release workflow's manifest or validation evidence. No push, tag, GitHub
Release, performance measurement or lifecycle soak is performed by this path.

See the [1.0.49 validation policy](validation-policy-1.0.49.md).
