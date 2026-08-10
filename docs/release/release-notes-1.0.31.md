# EZTerminal 1.0.31

Release identity: remote protocol v7, Android versionCode 52.

## Mobile PC-control interaction

PC Control now uses a persistent, draggable edge handle instead of a wide
always-visible toolbar. The handle opens a session sheet with precision or
direct-touch input, fit and monitor controls, three streaming preferences,
remote keyboard and clipboard actions, live metrics, and disconnect. Its
position, input mode, quality preference, and related choices persist locally.

The video surface supports one-finger pointer movement and click/drag,
long-press right click, pinch zoom, two-finger pan, two-finger fit/2x toggle,
and three-finger wheel input. Physical Bluetooth mouse buttons and wheels use
the same bounded input path. The remote keyboard supports IME text, sticky
modifiers, navigation and editing keys, and F1-F12. Backgrounding, reconnect,
cancellation, and disconnect release all pressed keys and buttons; returning
from the background requires an explicit Resume.

## Adaptive view and image quality

The client computes the normalized desktop region that is actually visible at
the selected zoom and pan. A capable host captures that region with bounded
overscan and acknowledges the exact applied revision after its first encoded
frame. Direct-touch input remains blocked until that acknowledgement arrives,
preventing coordinates from being applied to stale pixels. Older hosts remain
usable through capability-gated full-frame behavior.

Balanced, Clarity, and Responsiveness preferences select distinct resolution,
frame-rate, and bitrate ladders. Adaptation now considers host capture/encode
pressure together with client decoded FPS, dropped frames, and playback
freezes. Session metrics report the target and decoded frame rates, client
pressure, applied view revision, and the actual runtime capture and encoder
backends.

## Windows capture and H.264 pipeline

The native host attempts DXGI Desktop Duplication capture first, including
physical-pixel region extraction, cursor composition, and high-quality scaling.
Unsupported rotation, initialization failures, or runtime duplication failures
fall back to same-geometry GDI capture.

H.264 encoding attempts a low-latency Media Foundation hardware transform
first. Its output is normalized to Annex B for WebRTC. If a hardware transform
is unavailable or fails at runtime, the same frame is encoded with OpenH264.
Telemetry reports the backend actually producing the stream instead of the
preferred backend.

## Compatibility and artifacts

Remote protocol v7 and the Electron-to-Rust native desktop protocol v2 are
unchanged. New region, quality, and client-playback fields are optional and are
sent only when the peer advertises the corresponding capability. Persisted
layouts, pairing identities, and terminal-only remote access are unchanged.

- Windows 10 22H2/Windows 11 x64: `EZTerminal-Setup.exe`
- Android 10 (API 29) or newer:
  `EZTerminal-Android-1.0.31-vc52.apk`

The Windows installer is Authenticode `NotSigned` while the SignPath
Foundation application remains pending. The Android APK must use the existing
long-term EZTerminal release certificate.

## Release validation profile

This release uses the `functional-hotfix` validation profile. It runs version,
documentation, style, desktop, native, packaged, Android, Storybook, visual,
accessibility, and ordinary E2E gates without running or claiming the
separately authorized desktop performance benchmark or 30-minute mobile soak.
Physical Android/GPU/network combinations and hardware Media Foundation
selection remain field-validation items; the runtime falls back explicitly and
reports the backend in use.

See the [1.0.31 validation policy](validation-policy-1.0.31.md).
