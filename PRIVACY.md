# Privacy policy

EZTerminal does not operate an analytics, advertising, crash-reporting, or
telemetry service. It does not send terminal contents, commands, files,
credentials, captured packets, desktop frames, clipboard data, or pairing
tokens to the project maintainers.

The desktop app checks the latest stable release through GitHub's public API.
This sends ordinary connection metadata, such as the user's IP address and
user agent, to GitHub. Automatic checks can be disabled before launch with
`EZTERMINAL_DISABLE_UPDATE_CHECK=1`; a manual update check or download also
contacts GitHub. GitHub's handling of that request is governed by the
[GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Other network communication occurs only for features configured or requested
by the person operating the app: shell/SSH connections, OpenClaw integration,
and the optional Android remote-control bridge on a selected trusted VPN.
Those destinations and providers are chosen by the operator. Tailscale users
should also review the [Tailscale privacy policy](https://tailscale.com/privacy-policy).

Settings, host keys, session metadata, and encrypted pairing credentials are
stored locally. Packet capture is processed locally and is not transmitted by
EZTerminal. Removing the app through its uninstaller removes the application;
user data intentionally retained by the installer can be deleted from the
Electron `userData` directory by the user.

SignPath is used only in the project's release CI and is not contacted by the
installed application. Its service privacy policy is available from
[SignPath](https://about.signpath.io/privacy-policy).
