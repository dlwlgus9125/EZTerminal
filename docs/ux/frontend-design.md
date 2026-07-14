# EZTerminal Orca-Inspired Productivity Surfaces

## Product surface and audience

EZTerminal is a dense operational terminal for developers who run structured
commands, long-lived PTY programs, and coding agents on desktop, with a paired
Android client for observing and controlling existing desktop sessions. The
design must keep terminal output primary, make attention states discoverable
without becoming a dashboard, and never turn selection, hover, preview, or
drop gestures into implicit execution.

The scope of this artifact is the approved first delivery:

- Agent Attention Hub for Codex, Claude, and generic CLI lifecycle fallback.
- xterm search, safe web links, Unicode 11, and desktop WebGL fallback.
- Desktop Quick Open/Commands.
- Rich file preview on desktop and connected mobile, plus desktop file drop.

The approved second delivery extends the same terminal-first direction with:

- Hardened desktop/mobile pairing credentials and transient mobile reconnect.
- Destructive terminal close confirmation, opt-in OSC 52 clipboard writes, and
  workspace-contained terminal file-location links.
- Safe OpenSSH alias resolution, Git worktree commands, semantic terminal
  restore, and loopback-only SSH local-forward status/control.

The approved third delivery reduces interaction friction without adding a new
product area:

- MRU pane switching, accessible terminal/tab context menus, and persistent
  terminal titles.
- A responsive mobile header and configurable terminal accessory-key deck.
- Tiered connection recovery feedback and bounded input-control reclaim.
- Direct desktop Quick Commands access plus capability-gated, read-only mobile
  access. Focus-follows-mouse remains explicitly out of scope.

## Direction decision

Three directions were considered during planning:

1. **Integrated terminal chrome (selected):** status dots on existing tabs, a
   collapsible right Agent Hub, a centered Quick Open overlay, and an expanded
   existing file viewer. This preserves maximum terminal locality and reuses
   the established drawers and overlays.
2. **Consolidated left activity rail (rejected):** agents, files, and commands
   share a permanent icon rail. It creates stronger navigation but competes
   with the existing File Explorer and reduces small-window terminal width.
3. **Dashboard/dock tab (rejected):** agent activity becomes a normal Dockview
   tab. It offers more room but hides attention behind tab navigation and makes
   a lightweight status feature feel like a separate product area.

The user selected option 1. No Figma or external mock is normative; this
repo-owned document is the source of truth. If a future mock conflicts with
it, this document must be updated before implementation follows the mock.

For the third delivery, three compatible directions were considered:

1. **Keyboard continuity:** MRU switching and semantic context menus reduce
   pane-navigation and command-discovery cost without changing terminal input.
2. **Mobile density and reachability:** 44px accessory keys and a responsive
   More sheet preserve one-handed access at 360px without adding a dashboard.
3. **Recovery and continuation:** connection tiers, explicit retry, control
   reclaim, and safe Quick Command insertion connect an interruption to the
   next user action without queuing or automatically executing input.

The user approved the combined direction for UX-01 through UX-07. UX-08
focus-follows-mouse was rejected because implicit focus can redirect terminal
keystrokes. All seven approved items borrow Orca concepts only; no Orca source
is a normative implementation artifact.

## Screen inventory and information architecture

### Desktop

- **Terminal workspace:** unchanged primary surface. Each Dockview tab may
  show one agent-status dot. The header gains an Agents control with unread
  count. File Explorer remains an independent left drawer.
- **Agent Hub:** non-modal 300px right drawer occupying the same exclusive slot
  as Status, Pairing, Settings, and OpenClaw. Sections are ordered Attention
  (`blocked`, `error`, `waiting`), Active (`starting`, `working`), then Recent
  (`done`). Rows expose provider, cwd basename/full-path tooltip, status, age,
  and Focus/Open. Waiting rows expose a one-line follow-up composer; blocked
  rows only open the terminal for approval.
- **Quick Open:** centered modal overlay. `Ctrl/Cmd+P` opens All mode and
  `Ctrl/Cmd+Shift+P` opens Commands mode. One input searches panes, in-memory
  history, saved Quick Commands, files below the active cwd, app actions,
  presets, and agent launch items. A secondary Manage Quick Commands editor
  owns create/update/delete.
- **File viewer:** existing overlay upgraded to text, safe Markdown, supported
  raster images, PDF metadata/actions, and unsupported/error states. Desktop
  actions are Insert, Open in default app, Reveal, Retry, and Close where
  applicable.
- **Terminal find bar:** scoped to one full xterm block. It is visually attached
  to the block rather than the application header.
- **Settings:** adds Agent Integrations/Notifications and Terminal Renderer.

### Connected Android client

- **Agent Hub:** full-screen view entered from the mobile header badge. It
  mirrors the desktop grouping, supports Focus/Open and waiting follow-up, and
  has explicit disconnected/reconnecting states. It does not configure desktop
  hook files and has no background push notification surface.
- **File viewer:** existing full-screen viewer gains safe Markdown, raster
  images, PDF metadata, unsupported/error states, Insert, Download, Retry, and
  Back.
- **Terminal:** Search, safe links, and Unicode 11 are available; renderer is
  always DOM. No mobile Quick Open or file drag surface is added.

### Second-delivery additions

- **Desktop terminal tabs:** the existing tab close action opens one compact
  destructive confirmation only when the creator-owned session still has a
  running command, active agent, SSH prompt, or SSH shell. Mirror-only tabs
  close immediately. Cancel is the initial focus. On Confirm, the interpreter
  atomically compares the expected active run IDs and fails closed if they
  changed while the dialog was open. Preset replacement first preflights the
  layout in a detached inert Dockview, then holds a short command-submission
  lock through one atomic creator-session batch. An unresolved pane/session
  binding blocks the operation; the final creator check and `fromJSON` run in
  the same task. Acknowledged sessions are marked complete so pane unmount does
  not send a duplicate destroy request.
- **Mobile reconnect layer:** after the first successful pairing,
  `MobileWorkspace` remains mounted under a non-modal reconnect scrim. The
  active terminal stays visible but dimmed, input controls are disabled, and
  a live region reports reconnect, authentication rejection, lease expiry, or
  recovery. The initial Connect screen is not reused for transient outages.
- **Terminal path action:** desktop exposes file locations only through
  Ctrl/Cmd-click. Mobile opens a bottom action sheet with Preview, Copy path,
  and Cancel. The existing rich preview switches Markdown to source view when
  an exact line/column was requested and highlights that location. Preview
  consumes a main-owned, short-lived one-shot file-identity capability so the
  resolved target cannot be substituted before open.
- **Settings additions:** existing Settings gains two ordinary rows for
  “Confirm before closing a running terminal” and “Allow OSC 52 clipboard
  writes”. Pairing shows a blocking storage/permission error when credentials
  cannot be protected. A compact SSH forwards section lists connection id,
  loopback endpoint, destination, state, and Stop; it does not become a new
  rail or dashboard.
- **Worktrees:** create/list/open/remove remain terminal commands whose table
  output uses existing block rendering. Opening creates a normal terminal tab;
  no repository management screen is introduced. Mobile exposes only list and
  open.
- **Terminal restore feedback:** successful delta/semantic restore is quiet.
  A truncated raw fallback adds one inline warning above the affected PTY;
  missing or expired runs end visibly instead of being silently recreated.
  Historical OSC 52 is rendered with side effects suppressed.
- **SSH connection identity:** an active SSH block may show its short
  connection id with a Copy action so a local terminal can issue explicit
  forwarding commands. Interactive SSH reconnect and tunnel state remain
  visibly separate.

### Third-delivery additions

- **Desktop pane switcher:** `Ctrl+Tab` opens an eight-row MRU overlay;
  repeated chords preview, modifier release commits, and Escape/window blur
  cancels. Rows show title/cwd and textual run, draft, agent-attention, or
  offline state. The chord never reaches the PTY.
- **Desktop context menus and titles:** terminal and tab menus use menu
  semantics, roving keyboard focus, shortcut labels, and deterministic focus
  restoration. Tab rename is inline, IME-safe, capped at 80 characters, and
  persisted through the existing layout title field. Risky Close continues to
  use the existing atomic guard.
- **Mobile terminal header:** below 600px, direct actions are TabStrip, New,
  Agents, and More; from 600px, Sessions and Files are also direct. More owns
  Stats, Theme, optional OpenClaw, and Settings. Remote-only rows disable while
  offline; local settings remain usable.
- **Mobile accessory keys:** the current eight-key layout remains the default.
  Settings may show/hide/reorder built-in keys and reset the layout. Only
  arrows, Backspace, and Delete repeat; arbitrary text macros and implicit
  Enter are not supported.
- **Connection recovery:** the mounted workspace stays visible while a banner
  progresses from connecting/reconnecting to warning, unreachable, or
  authentication failure. Retry starts exactly one fresh dial. Diagnostic
  events are bounded and exclude endpoint text, credentials, cwd, commands,
  terminal output, and drafts.
- **Input control:** a compact, non-obscuring chip identifies view-only PTYs.
  Desktop can reclaim every mounted eligible controller with bounded
  concurrency and a partial-result summary; mobile reclaims only its current
  run. No action steals focus from another active composer.
- **Quick Commands shelf:** desktop exposes the existing saved commands beside
  the composer. Primary interaction inserts text; Run is always a distinct
  action using the existing busy/draft/control gate. Mobile receives a bounded
  read-only list only when the paired host advertises support, keeps command
  text in memory only, and never replays it after reconnect.

Primary flows are terminal -> attention badge -> Agent Hub -> Focus session;
terminal -> Quick Open -> insert/preview/activate; and File Explorer/OS drag ->
preview or explicit path insertion. Escape returns overlays to their invoker;
closing a right drawer returns focus to the workspace.

## UX state matrix

| Journey | Loading / long-running | Empty | Error / permission | Offline / cancellation | Success |
| --- | --- | --- | --- | --- | --- |
| Agent Hub | Initial snapshot skeleton; live age labels | "No agent activity" with integration shortcut | Hook drift/managed config guidance; failed follow-up inline | Mobile reconnect banner; pending follow-up fails without retrying | Status transition announced; Focus selects exact pane |
| Hook integration | Inspecting provider config | Provider executable/config absent | Invalid JSON is never overwritten; Codex trust review is explained | Install can be cancelled before write | Installed/removed state and backup path shown |
| Quick Open | File source shows a small indexing row after query input | Empty All mode shows recent/useful items; no-match message | Disabled execution row explains busy/dead/non-empty draft | Escape closes without action; stale searches discarded | Action closes only after a completed explicit operation |
| Quick Command editor | Save button busy during atomic write | Empty list has Add action | Field-level name/command/description validation; corrupt store quarantined | Cancel discards editor draft | Saved row is selected and change broadcast updates open windows |
| Terminal search | Incremental result count | `0 results` | Addon failure hides search affordance without breaking PTY | Escape clears highlights/refocuses terminal | Current/total result announced |
| WebGL renderer | Auto initialization has no blocking UI | N/A | Falls back to DOM and exposes compatibility status in Settings | Context loss stays DOM until remount | Active renderer is visible diagnostically |
| File preview | Progress for chunked image transfer | Zero-byte text renders empty content | Oversize, dimensions, unsupported, read and decode errors have explicit messages | Mobile disconnect cancels transfer; Retry starts a new request | Blob URL lives only while the selected preview is open |
| File drop | Drop target highlight only | N/A | Too many paths, busy/dead pane, non-agent PTY each produce toast | Drag leave removes highlight; drop never auto-runs | Quoted paths are inserted/pasted without newline |
| Credential migration | Native store read and legacy cleanup progress | No saved host shows ordinary Connect form | Keystore/safeStorage/DACL/mode failure names Retry or reset; never suggests localStorage fallback | Cancellation leaves legacy data untouched and blocks autofill | Secure read-back succeeds before legacy token deletion; Windows schema-v1 token is encrypted before bridge use |
| Mobile reconnect | Workspace stays mounted; active session resumes first | No resumable runs keeps tabs but marks ended blocks | Invalid token stops retry and requests pairing; lease expiry identifies ended runs | Explicit Disconnect releases leases and returns to Connect | Same tab/xterm identity resumes with no queued input |
| Risky close | Runtime/agent state is rechecked before confirmation; preset layout is detached-preflighted | Idle or mirror-only pane closes immediately | Unknown/pending binding, invalid preset topology, or changed active-run IDs fail closed | Cancel restores prior focus with no partial bulk close; preset apply failure is surfaced | Confirm atomically matches expected runs; preset batch holds the run gate through the synchronous final apply |
| OSC 52 | No progress UI; writes are rate-limited | Disabled is the default | Invalid, query, oversized, replayed, or clipboard failure has no terminal reply | Toggle takes effect without remount | Valid enabled live desktop write updates clipboard once |
| Terminal file location | Resolution occurs only after explicit action | Missing link target leaves terminal unchanged | Outside-root, device, remote SSH, missing, directory, or a stale/consumed capability shows a concise toast | Mobile sheet Cancel has no effect | One-shot file identity opens the existing preview at highlighted line/column |
| SSH alias | Resolver may show a short connecting status | No matching alias explains direct syntax | Match/exec/proxy/forward, timeout, missing OpenSSH and malformed config fail before connect | Cancel follows the existing SSH prompt path | Resolved allowlisted host enters existing TOFU/auth flow |
| Worktree command | Git mutation row stays running until bounded process exits | List returns the normal empty table | Dirty/in-use/unmanaged/locked states return stable remediation codes | No partial close or recursive cleanup on failure | Open selects a new terminal rooted at the registered worktree |
| Terminal state restore | Reattach is gated while snapshot and tail are applied | No snapshot falls back to recent-output state | Gap, epoch mismatch, serializer limit, or queue overflow requests resync | View detach never implies hidden process input | Cursor/grid/modes match the authoritative model |
| SSH local forward | Starting/reconnecting/auth-required are explicit states | No forwards shows one compact empty row | Port collision, remote reject, host-key change, and auth-required remain visible | Stop closes listener and streams before removing row | Active row exposes only `127.0.0.1:port` |
| MRU pane switching | No loading; the overlay is built from the current registry | Zero/one pane is a no-op | Stale pane ids are removed before commit | Escape or blur restores the original pane | Modifier release activates one pane and restores terminal/composer focus |
| Context menu / rename | No loading | Unavailable actions are omitted or disabled with a reason | Clipboard or stale-target errors use existing status feedback | Escape cancels and restores the invoker; blank rename restores generated title | Rename persists through the existing layout title field |
| Mobile accessory keys | Stored preference is read without blocking the default layout | All hidden retains Manage and Reset | Corrupt data resets to default; write failure keeps a session-only layout with Retry | Offline/view-only keys disable; repeat stops on cancel, background, tab change, or disconnect | One tap emits exactly one built-in byte sequence |
| Mobile header / More | No blocking loading state | Optional actions are omitted | Failed action remains visible with an inline/alert message | Android Back, Escape, or backdrop closes and restores More focus | Selected view opens after the sheet closes |
| Connection recovery | Connecting/retrying exposes attempt tier and next retry visually | Session list has an explicit no-sessions state | Warning, unreachable, auth-failed, list error, and create error have distinct recovery actions | Workspace/drafts remain mounted; no input queue or automatic replay | One successful handshake resets attempts and authoritatively refreshes sessions |
| Input-control reclaim | Pending targets disable duplicate actions | No eligible controller hides the chip/action | Timed-out or ended targets produce a partial result and failed-only Retry | Offline disables reclaim; user typing elsewhere retains focus | Successful targets report control within two seconds |
| Quick Commands shelf | Mobile fetch occurs only when the sheet opens or reconnects | Desktop offers Manage; mobile says to add commands on desktop | Fetch error offers Retry; unsupported hosts hide the affordance | Offline Insert changes draft only; Run disables; closing clears mobile command text | Insert preserves the draft; explicit Run passes the existing execution gate |

## Design system and tokens

The existing repo-owned `--term-*` variables, `.btn` primitives, drawer
chrome, inputs, overlays, Dockview styling, font selection, and four theme
definitions remain authoritative. New surfaces must not introduce fixed theme
colors when a semantic token exists.

- Color roles: `--term-green` success/working action, `--term-blue` active,
  `--term-amber` waiting/warning, `--term-red` blocked/error,
  `--term-cyan` section accent, existing fg/bg/border roles for structure.
- Typography: existing terminal font and density. Headings use existing
  uppercase/letter-spacing conventions; no new font assets.
- Spacing: 4px micro, 8px control, 12px row, 16px section rhythm.
- Radius/shadow: reuse existing button/input/overlay values; terminal visuals
  stay restrained and primarily border-separated.
- Motion: 120-160ms color/opacity transitions only. Disable nonessential
  transitions under `prefers-reduced-motion`.
- Layering: drawers retain the current 155 layer, file viewer uses 160, Quick
  Open uses 170, and context/tooltips must remain above their owning surface.

Agent status uses shape plus text/accessible label, never color alone. Provider
identity uses text badges (`Codex`, `Claude`, `CLI`); vendor logos are not used.

## Component taxonomy

- **Primitives:** existing Button/Input/Badge/Toast conventions, `StatusDot`,
  `ProgressLine`, `EmptyState`, `InlineError`.
- **Navigation:** header Agents control, Dockview tab status decorator, mobile
  Agent entry, exclusive `RightRail` state.
- **Agent composition:** `AgentHub`, `AgentActivityGroup`, `AgentActivityRow`,
  `AgentFollowupComposer`, `AgentIntegrationSettings`.
- **Quick composition:** `QuickOpenModal`, `QuickOpenInput`, grouped result
  list/row, source badge, disabled-reason footer, `QuickCommandEditor`.
- **Terminal composition:** `XtermRuntime` adapter, `TerminalFindBar`, link
  hover decoration, renderer setting row.
- **File composition:** discriminated `FilePreview`, `MarkdownPreview`,
  `ImagePreview`, `PdfPreview`, `UnsupportedPreview`, `FileDropTarget`.
- **Adapters:** `PaneRegistry`, `ExternalLinkAdapter`, Agent snapshot transport,
  preview stream transport. These keep platform checks out of components.
- **Second-delivery feedback:** `ReconnectScrim`, `RiskyCloseDialog`,
  `TerminalPathActionSheet`, `TerminalRestoreNotice`, `CredentialSecurityError`.
- **Second-delivery adapters:** `CredentialStore`, `TerminalPathResolver`,
  `RemoteRunLease`, `TerminalStateRelay`, `WorktreeService`,
  `SshConnectionRuntime`, and `SshForwardService`. Security and platform
  policy stay outside React components.
- **Third-delivery primitives:** `MenuSurface`, `MobileActionSheet`,
  `ConnectionHealthBanner`, `ControlOwnershipChip`, and the existing Button,
  Input, Badge, Toast, and dialog conventions.
- **Third-delivery composition:** `RecentPaneSwitcher`, tab rename editor,
  `TerminalAccessoryToolbar`, `MobileHeaderMoreActions`,
  `QuickCommandShelf`, and `MobileQuickCommandSheet`.
- **Third-delivery adapters:** renderer MRU model, accessory preference store,
  connection-health classifier/event ring, mounted-controller enumerator, and
  capability-gated Quick Command list transport.

## Responsive and overflow rules

- Desktop supports 800x600 and larger. The right rail stays 300px; terminal
  content owns the remaining width and may collapse before the rail changes
  width. At widths below 720px, Quick Open uses 8px viewport insets and a
  maximum height of `calc(100vh - 16px)`; otherwise it is at most 680px wide
  and 70vh high.
- Agent/provider badges and status never shrink. Cwd and descriptions ellipsize
  on one line with a full-value tooltip. Quick results keep primary text to one
  line and optional detail to one line.
- Mobile views are full-screen and safe-area aware. Interactive targets are at
  least 44x44px, follow-up text does not horizontally scroll the viewport, and
  image previews use contain sizing rather than cropping.
- The reconnect scrim never changes the terminal's measured dimensions. Mobile
  action sheets respect the bottom safe area and use 44x44px minimum actions.
  Forward/worktree identifiers ellipsize visually but remain copyable in full.
- At 360px the mobile header exposes at most New, Agents, and More beside the
  flexible TabStrip; the active tab retains at least 96px. At 600px Sessions
  and Files return to the header. No breakpoint may create page-level
  horizontal overflow.
- Accessory keys, tab close, More rows, control chips, and Quick Command actions
  have a minimum 44x44px hit area. Accessory and command strips may scroll
  internally while the page remains fixed.

## Accessibility

- Quick Open is a labelled modal with a focus trap, active-descendant result
  semantics, arrow navigation, Home/End, Enter variants, and focus restoration.
- Agent Hub is non-modal. Rows have explicit provider/status labels; status and
  unread changes use a polite live region without announcing elapsed-time
  updates. Follow-up validation is connected with `aria-describedby`.
- Terminal Find captures only its documented shortcuts; Escape restores xterm
  focus and clears highlights. Search counts use a polite live region.
- Preview controls are keyboard reachable, images expose filename-derived alt
  text, Markdown heading/link semantics remain intact, and unsupported states
  are readable without icons.
- All focus rings use existing high-contrast tokens. Every theme must preserve
  readable status text and a visible focused control. Reduced-motion settings
  remove decorative transitions.
- Destructive close dialogs are labelled, focus-trapped, default to Cancel,
  and restore the invoking tab/action focus. Reconnect and terminal-restore
  changes use polite live regions; repeated retries and elapsed time are not
  repeatedly announced. Path action sheets expose a labelled Cancel action and
  do not treat a terminal tap as execution.
- The MRU overlay exposes one selected option through active-descendant or an
  equivalent listbox relationship and announces selection only when useful;
  modifier repeats never become terminal input.
- Context menus support Arrow keys, Home/End, Enter/Space, Escape, Shift+F10,
  and the Menu key. Closing a menu or mobile sheet restores its invoker unless
  the chosen action explicitly moves focus to a terminal.
- The accessory deck is a labelled toolbar. Reorder supports buttons or
  accessibility actions in addition to drag, and every key has a semantic
  name rather than a symbol-only accessible name.
- Connection retry countdowns are visual only; screen readers announce tier
  changes once rather than each second. Control-reclaim partial results and
  Quick Command validation use text plus icon, never color alone.

## Asset and security policy

No generated imagery, vendor logo, remote font, or new binary asset is needed.
Use existing text/icons and CSS. Markdown raw HTML is disabled, remote/relative
images do not auto-load, external links accept only validated HTTP(S), SVG is
never rendered as an image, and preview Blob URLs are revoked on switch/close.
Drop and result-selection gestures never imply execution, upload, or submit.
Terminal output is also untrusted: OSC 52 is disabled by default and
write-only, and semantic replay suppresses its side effects. Path links require
an explicit gesture, a main-side workspace check, and a short-lived one-shot
file-identity capability. Confirmed risky closes atomically match the expected
active run IDs in the interpreter. SSH config commands are never evaluated
from the renderer, worktree remove has no force/fallback delete, and SSH
forwarding binds exactly to IPv4
loopback. No credential, clipboard payload, terminal snapshot, or SSH secret is
rendered into diagnostic UI or stored in visual artifacts.

## Visual QA and implementation sequence

The repo has browser/Electron E2E but no checked-in Storybook, screenshot
baseline, or visual-diff lane, so these remain advisory rather than hard gates.
The required order is existing tokens/primitives -> shared adapters and state
components -> desktop screens -> mobile screens -> interaction E2E.

Manual visual review covers all installed themes at 800x600 and 1024x720, and
Android at 360x800 and 412x915. It verifies drawer exclusion, modal layering,
keyboard focus, long paths, empty/error/loading states, touch targets, reduced
motion, and DOM/WebGL terminal parity. Existing component tests and Playwright
flows are the automated user-visible oracle; screenshots in `docs/screenshots`
are reference-only and are not freshness-gated.

Second-delivery review additionally covers close-dialog focus restoration,
reconnect without xterm resize/remount, path action-sheet safe areas, exact
line highlighting, credential-error recovery, truncated terminal restore, and
SSH forward states. These follow the same component/Playwright/manual lane;
the delivery does not introduce Storybook or a screenshot baseline.

Third-delivery implementation order is MRU switcher -> menu/title primitive ->
mobile action-sheet/header -> accessory deck -> connection health -> control
reclaim -> Quick Commands transport/surfaces. Review additionally covers
Ctrl+Tab leakage into xterm, keyboard-only menus, 360px header overflow,
long-press repeat cancellation, reconnect without xterm remount, partial
control reclaim, old-host capability fallback, and the absence of automatic
Quick Command execution. Storybook and screenshot baselines remain advisory;
component tests, Playwright, packaged Electron smoke, and Android development
device/emulator checks are the required observable oracle.
