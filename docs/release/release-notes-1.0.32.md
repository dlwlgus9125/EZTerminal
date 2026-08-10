# EZTerminal 1.0.32

Release identity: remote protocol v7, Android versionCode 53.

## Bluetooth keyboard and mouse in PC Control

An Android device's already-paired Bluetooth keyboard and mouse now work on
the active remote PC video surface without a separate setting or opening the
on-screen keyboard. The surface takes focus when PC Control becomes active and
after its session sheet closes.

Physical keyboard transitions cover letters, digits, punctuation, left/right
Ctrl, Alt and Shift, Windows keys, navigation and editing keys, and F1-F12.
They remain physical key events so the selected Windows keyboard layout and
IME own interpretation. Android-reserved keys and codes unsupported by the
Windows host are left to the device.

Physical mouse hover no longer requires a prior button press. Precision
pointer mode sends relative movement, while Direct touch sends absolute
coordinates. Left, right and middle buttons, click/double-click timing, drag,
and horizontal and vertical wheel input continue through the existing bounded
remote-input channels.

Only the active video surface captures this hardware input. Session sheets,
local controls, reconnect/close states and the background do not. Focus loss,
visibility or session changes, mode/display changes, cancellation and close
release all client-tracked keys and buttons. Existing touch gestures, explicit
IME input, keyboard accessory and non-remote Android input remain available.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged. The fix normalizes browser hardware events into the existing key,
pointer, button and wheel commands, so it adds no capability negotiation or
wire-format requirement.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.32-vc53.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs version,
documentation, style, desktop, native, packaged, Android, Storybook, visual,
accessibility and ordinary E2E gates. It does not run or claim the separately
authorized performance benchmark or 30-minute mobile soak.

Automated browser-component tests cover focus, supported and reserved key
handling, pressed-key cleanup, hover, relative/absolute pointer modes,
right/middle buttons and both wheel axes. A physical Android device with each
OEM WebView and Bluetooth keyboard/mouse combination is not a public-release
gate for this hotfix and remains residual field-validation risk.

See the [1.0.32 validation policy](validation-policy-1.0.32.md).
