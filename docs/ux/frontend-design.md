# EZTerminal Adaptive Workbench UI/UX Specification

## 1. Normative status

This document is the source of truth for the commercial-readiness UI/UX
redesign of the EZTerminal Electron desktop client and connected Android web
client. Product UI implementation, stories, tests, and screenshots must agree
with it. When code and this document disagree, update this document through an
explicit product decision before changing the implementation contract.

The delivery is one complete release. Internal implementation may be staged,
but partially migrated navigation, duplicate destinations, or mixed component
systems are not a shippable state.

In scope:

- Desktop and Android information architecture, navigation, panels, layout,
  responsive behavior, visual language, accessibility, and localization.
- A shared semantic design system and platform-specific application shells.
- Backward-compatible desktop settings and custom-theme evolution.
- Storybook, accessibility checks, deterministic visual regression, and CI
  quality gates.

Out of scope:

- Backend, terminal protocol, pairing/security, command semantics, and process
  lifecycle changes.
- A product tour, analytics/telemetry, Figma deliverables, raster illustrations,
  generated imagery, remote fonts, or new vendor branding.

## 2. Product, audience, and experience principles

EZTerminal is a terminal-first operational workbench for developers running
long-lived shells, structured commands, SSH sessions, and coding agents. The
desktop is the authoring and control surface; the Android client is a durable
companion for observing and controlling the same work without losing terminal
state when auxiliary pages open.

Every UI decision follows these principles, in order:

1. **Terminal remains primary.** Chrome supports the work and never turns the
   application into a dashboard.
2. **One destination, several efficient entry points.** Navigation may expose a
   destination in the rail and Command Center, but must not create duplicate
   implementations or conflicting state.
3. **Explicit action over surprise.** Selection, preview, insertion, drop, and
   navigation never imply command execution.
4. **State survives navigation.** Terminal controllers, drafts, scroll position,
   xterm geometry, reconnect state, and selection are durable across auxiliary
   UI transitions.
5. **Matrix identity with professional restraint.** CRT character belongs in
   the visual surface; legibility and reduced-motion preferences take priority.
6. **Keyboard, pointer, touch, and assistive technology are first-class.** A
   flow is incomplete if one input mode cannot finish it.
7. **Korean and English are equal product languages.** Layouts tolerate both,
   and system language selection is deterministic.

## 3. Direction decision

Three product directions were evaluated:

1. **Adaptive Workbench — selected.** A compact four-zone desktop header, a
   stable activity rail, one responsive sidebar shell, and a persistent mobile
   terminal layer create clear hierarchy without stealing terminal area.
2. **Permanent multi-column dashboard — rejected.** It exposes more at once but
   reduces terminal width and makes secondary telemetry feel primary.
3. **Overlay-first minimal shell — rejected.** It maximizes canvas area but hides
   destinations, weakens spatial memory, and makes repeated workflows slower.

The selected direction combines stable spatial navigation at wide widths with
a single modal-style sidebar at narrow widths. It deliberately removes the
current collection of unrelated header buttons and exclusive one-off drawers.

### 3.1 Brand and CRT restoration decision

The user-supplied `타이틀.PNG` is a visual reference for identity, not a raster
asset shipped in the application. It establishes three required cues: the
three-bar signal mark, the full `EZTerminal` name, and a green phosphor/scanline
surface. The implementation remains code-native so text stays selectable,
sharp at 100–150% scale, accessible, and responsive. The reference is
user-owned, may be cropped to the title area, and remains current until the user
supplies a replacement.

Three restoration directions were evaluated:

1. **Full legacy CRT restoration** — restores every animated legacy effect and
   separate EFFECT/CRT hardware-style switches. This has the strongest nostalgia
   but adds header clutter and makes flicker/jitter accessibility harder.
2. **Signal Wordmark + CRT Signature — selected.** Restores the signal mark and
   full wordmark, then exposes one compact `FX · <profile>` appearance control
   backed by the existing effect engine and Settings controls.
3. **Wordmark-only restoration** — restores only the title treatment. This is
   clean but does not satisfy the requested EFFECT/CRT identity.

The user delegated the detailed visual refinement after explicitly requesting
that the title, EFFECT character, and CRT character be restored. Direction 2 is
therefore the implementation decision: it preserves the approved workbench
hierarchy while restoring a recognizable product signature.

### 3.2 Codex terminal safety direction

Three ways of exposing Codex-specific keyboard safety were evaluated:

1. **Minimal safety UI — selected by the user.** Keep the terminal visually
   unchanged, show one brief notice the first time a Codex run blocks `Ctrl+C`,
   and show a dialog only for risky text paste.
2. **Persistent safety badge — rejected.** A pane-level badge would improve
   discoverability but consume terminal space throughout every Codex run.
3. **User-defined Codex keymap — rejected for this release.** Full remapping
   would be flexible but substantially expand settings, validation, and support
   burden beyond the requested safe Windows-terminal behavior.

The policy applies only to directly launched Codex commands. With no terminal
selection, `Ctrl+C` and `Ctrl+D` are consumed; `Escape` continues to the Codex
TUI; `/exit`, `/quit`, and the explicit force-stop action remain the exit paths.
With a selection, `Ctrl+C` and `Ctrl+Insert` copy only that terminal surface.
Generic PTYs retain their control-byte behavior.

Clipboard paste is format-aware. Text uses the terminal's paste adapter;
image-bearing `Ctrl+V` in Codex is handed to Codex so it owns image attachment
and temporary-file cleanup. `Ctrl+Shift+V` and `Shift+Insert` explicitly request
text when both formats exist. Multiline and text larger than 5 KiB use one
small `alertdialog` that reports line count and size without displaying or
logging clipboard contents. Cancel receives initial focus, Escape cancels, and
closing restores the invoking terminal focus. The two warnings are independent
Terminal & Safety settings and default on.

This addition uses the repository-owned `Dialog`, `Toast`, `Button`, and
`Switch` primitives and existing semantic tokens. It adds no route, breakpoint,
asset, font, color role, or mobile interaction. Storybook owns dialog states;
desktop Playwright owns keyboard, focus, clipboard, and screenshot coverage.

## 4. Desktop application shell

### 4.1 Layout anatomy

At widths of 1200px and above:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ New Terminal │ Command Center │ Workspace ▾              │ Attention 3 │
├────┬──────────────────┬──────────────────────────────────────────────────┤
│Rail│ SidebarShell     │ Terminal workspace / Dockview                   │
│    │ 280–440px        │                                                  │
│    │ default 320px    │                                                  │
│    │ resizable        │                                                  │
├────┴──────────────────┴──────────────────────────────────────────────────┤
│ Existing terminal/composer-owned status and feedback                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Below 1200px, `SidebarShell` becomes one overlay over the terminal workspace
with a scrim. Only one sidebar destination may be open. Escape and scrim click
close it and restore focus to its invoker. The activity rail remains the stable
entry point where space permits; at the smallest supported desktop width it may
collapse to icon-only controls but must not become a second drawer.

The supported desktop viewports are 800×600, 1024×720, 1200×800, and 1440×900.
No viewport may develop document-level horizontal scrolling.

### 4.2 Header: exactly four zones

The desktop header contains exactly these four product zones:

1. **New Terminal** — the primary creation action. A split-button may expose
   safe creation variants without adding adjacent header controls.
2. **Command Center** — opens the unified command/search surface for files,
   panes, saved Quick Commands, layouts, presets, settings, and destinations.
3. **Workspace menu** — owns Split, Layout, and Presets.
4. **Agent Attention** — opens/focuses attention work and includes the unread
   count in an accessible text label.

Zone 1 includes the `BrandMark` (three-bar signal plus the visible full
`EZTerminal` name) beside New Terminal. One compact `FX · <profile>` appearance
utility may also live in this zone. It is a presentation control, not a fifth
navigation zone; individual effect switches and parameters remain in Settings.

Theme, Files, Stats, Pairing, Settings, OpenClaw, runtime versions, and the
session connection dot do not appear as separate header actions. Runtime and
connection diagnostics belong in their relevant panel or transient status
feedback, not in global navigation.

### 4.3 Activity Rail

Top-to-bottom order is fixed:

1. Explorer
2. Agents
3. Monitor
4. Remote
5. OpenClaw, only when the integration is available

Settings is pinned at the bottom. Each control has a Lucide icon, tooltip, and
localized accessible name. Selection is conveyed by shape/border and text or
accessible state, never color alone.

The rail controls one `SidebarShell`; individual features must not create
parallel left drawers, right rails, or mutually exclusive bespoke containers.

### 4.4 Sidebar destinations

- **Explorer** contains the existing file navigation and preview entry points.
- **Agents** contains grouped agent attention, active work, recent activity,
  follow-up entry, focus/open, and integration guidance.
- **Monitor** combines the old Stats and Packet/traffic surfaces. Expensive
  stats polling starts only while Monitor is selected and visible, and stops
  when it is hidden.
- **Remote** combines pairing/remote-access state and SSH tunnel management.
- **OpenClaw** contains integration navigation. On wide layouts, its native
  `WebContentsView` participates in reflow and must not set the application
  `chatOverlayOpen` occlusion state. Only the narrow overlay form is occluding.
- **Settings** uses the same shell and the category structure in section 4.6.

Every destination defines loading, empty, error, offline, and success states.
Closing the shell returns focus to the activity-rail item or Command Center
result that opened it.

### 4.5 Command Center and duplicate entry policy

Command Center is the keyboard-first global entry surface. It searches or
navigates to existing functionality; it does not own duplicate feature state.

Representative destination ownership:

| Capability | Primary home | Additional entry |
| --- | --- | --- |
| Theme | Settings → Appearance | Command Center action |
| Files | Explorer | Command Center file search |
| Split/Layout/Presets | Workspace menu | Command Center action |
| Quick Commands | Composer shelf | Command Center manager/search |
| Agents/Monitor/Remote/OpenClaw/Settings | Activity Rail | Command Center navigation |

The current unused `CommandPalette.tsx` is not revived. The final Command
Center is one maintained implementation with labelled modal semantics,
keyboard navigation, active result indication, focus trapping, stale-search
cancellation, and focus restoration.

### 4.6 Settings information architecture

Settings categories are:

1. General
2. Appearance
3. Terminal & Safety
4. Agents
5. Integrations
6. About & Diagnostics

Appearance owns theme, UI density, terminal font, and CRT effect controls.
General owns language. Terminal & Safety owns terminal-specific behavior and
existing safety choices. Pairing, OpenClaw, and provider-specific configuration
are organized under Integrations instead of receiving independent settings
drawers. Runtime versions, renderer state, effective-theme correction details,
and diagnostic metadata live in About & Diagnostics.

## 5. Mobile application shell

### 5.1 Persistent workbench structure

After authentication, the DOM structure is composed as siblings:

```text
MobileWorkbenchCoordinator
├── TerminalLayer          (always mounted)
├── MobilePageShell        (opaque auxiliary page)
└── SheetDialogHost        (sheets, menus, dialogs)
```

Opening Sessions, Files, Agents, Settings, or another auxiliary page never
unmounts the terminal layer and never applies `display: none` to the terminal
root. While an opaque auxiliary page is active, the terminal layer is inert and
`aria-hidden="true"`; it retains drafts, controllers, xterm geometry, scroll
position, selection, and reconnect state. Returning to Terminal restores the
previous usable focus without recreating the session view.

Android Back precedence is:

1. close the top sheet or dialog;
2. leave the auxiliary page and reveal Terminal;
3. use the platform/application default behavior.

### 5.2 Responsive mobile header

Below 600px, the direct header actions are:

- flexible TabStrip
- New
- Agents
- More

At 600px and above, Sessions and Files become direct actions in addition to the
same controls. Other destinations remain in More. There is no bottom navigation
bar. If there are zero terminal tabs, the shell still exposes New, Settings,
pairing/connection recovery, and all locally usable actions.

All touch targets are at least 44×44 CSS pixels. Supported viewports are
360×800, 412×915, 600×960, and 915×412. The page itself never scrolls
horizontally; tab and accessory strips may scroll internally.

The mobile viewport must permit user zoom. `maximum-scale=1` and
`user-scalable=no` are prohibited.

### 5.3 Mobile CSS boundary

Mobile consumes shared semantic tokens, reset/accessibility utilities, terminal
runtime styling, and effect definitions. It does not import the complete
desktop stylesheet. Desktop shell/Dockview/sidebar rules and mobile shell/page/
sheet rules live in platform-specific files so selectors cannot accidentally
override one another.

### 5.4 Mobile layer history and recoverable operations

The authenticated mobile shell owns browser history through one serialized
navigation controller. Auxiliary pages, action sheets, and dialogs register a
typed layer with that controller; they do not install independent `popstate`
listeners or call `history.back()` during component cleanup.

- Opening a layer pushes one history entry.
- Choosing a More-sheet destination atomically replaces the sheet layer with
  the destination page. The sheet cleanup must not pop the new page.
- An explicit close consumes its layer exactly once. Repeated open/close and
  sheet-to-page transitions must not leave ghost entries.
- Android Back closes the top sheet/dialog, then the auxiliary page, then
  delegates to the application/platform default.
- Closing a transient layer restores its invoker. A sheet action that opens a
  page intentionally transfers focus into the page and skips invoker restore.

Remote and OpenClaw operations use contextual recovery rather than toast-only
feedback or a separate diagnostics route:

| Operation | Pending | Recoverable failure | Success |
| --- | --- | --- | --- |
| Remote listener | Stable inline `Starting` state; duplicate toggles disabled | Distinguish token security, address-in-use, and bind failure; retain the desired setting and offer Retry | Show QR and endpoint only after the listener is running |
| OpenClaw availability | Bounded check with the page still dismissible | Distinguish unavailable, gateway stopped, gateway unreachable, and timeout | Show live service state and available actions |
| Lifecycle/config mutation | Keep the initiating control and value visible; disable duplicate mutation | Show busy, invalid value, CLI failure, or timeout beside the control with Retry | Refresh the affected value/status without replacing the page |
| Chat ticket/frame | Stable loading surface with a bounded deadline | Distinguish proxy, token, gateway, insecure-auth, and frame-load failures; Retry always mints a fresh ticket | Reveal the frame only after its current generation loads |
| External browser | Button enters a bounded busy state | Native-browser failure remains beside the button | Open through the Capacitor Browser integration with a fresh ticket |

The desktop OpenClaw visibility preference is not a mobile API authorization
control. Mobile `auto` shows the destination only when available, `on` keeps a
diagnostic destination visible even when unavailable, and `off` hides it.

When the app is backgrounded, the OpenClaw frame and its subscriptions are
released. Foreground recovery obtains a fresh ticket and never reuses an
expired frame URL. The connect screen and terminal/session runtime remain
eager; auxiliary pages may be code-split, but every tap must render feedback in
the next frame so lazy loading never appears unresponsive.

Safe-area ownership is singular: the mobile root applies platform insets, the
workbench fills that inherited content box with `height: 100%`, and headers do
not add the top inset again. Folded, unfolded, and landscape layouts preserve
the 44px touch target contract.

## 6. Responsive and density behavior

The product supports an `adaptive` default density plus explicit `compact` and
`comfortable` user preferences. Adaptive resolves from platform and viewport;
it is not persisted as a series of per-component exceptions.

- Compact desktop control height: 32px.
- Comfortable desktop control height: 40px.
- Touch minimum: 44px, regardless of density.
- Sidebar width: 280–440px, default 320px, persisted on desktop.
- Long Korean/English labels wrap only where the component contract allows;
  navigation labels and paths otherwise ellipsize with a full-value tooltip.
- At 150% browser/UI scale, the supported viewports retain all primary actions
  and do not overlap the terminal or safe areas.

## 7. Design tokens and visual language

### 7.1 Token ownership

Application chrome uses semantic `--ui-*` tokens. Existing `--term-*` tokens
remain the compatibility bridge for xterm, terminal output surfaces, and v1
custom themes. New buttons, panels, menus, settings, and typography must not use
`--term-*` directly and must not embed theme-specific hex values.

Required semantic color roles include:

- canvas, surface, raised surface, inset surface, overlay and scrim;
- primary, secondary, muted and inverse text;
- subtle and strong borders;
- accent and on-accent;
- focus, info, success, warning, and danger.

Fixed scales:

| Role | Scale |
| --- | --- |
| Type | 12, 13, 14, 16, 20px |
| Space | 4, 8, 12, 16, 24, 32px |
| Radius | 2, 4, 8px |
| Controls | 32, 40, 44px touch minimum |

Z-index values are semantic tokens for base, sticky chrome, sidebar scrim,
sidebar, popover, dialog, toast, and tooltip. Components do not invent local
z-index ladders.

### 7.2 Typography

- Retro display typography is limited to the wordmark, short headings, and
  compact labels where character is useful.
- Body text, settings, help, and Korean use the local system UI stack.
- Terminal, code, commands, paths, identifiers, and diagnostic values use the
  configured monospace stack.
- Korean text is not forced uppercase and does not inherit excessive display
  letter spacing.
- No Pretendard or other new font asset is added.

### 7.3 Matrix/CRT identity

The default Matrix presentation uses a near-black green-tinted canvas, readable
light foregrounds, crisp green accent/focus states, restrained borders, and
semantic blue/success/amber/danger colors. Status meaning is never encoded only
as green variants.

The code-native `BrandMark` uses an `aria-hidden` three-bar signal mark and a
visible `EZTerminal` heading. Matrix uses the existing VT323 display face with
the existing monospace fallback; other themes use the semantic heading font.
Phosphor glow is applied only while the corresponding effect is enabled rather
than being permanently baked into the wordmark.

The Matrix default is the **CRT Signature** profile:

- static scanlines;
- restrained phosphor glow;
- one slow, low-opacity CRT roll band.

The compact header control offers four named profiles without creating a second
effect implementation:

- **Clean** — all effects off;
- **Static** — scanlines and phosphor glow;
- **CRT Signature** — Static plus the slow CRT roll band;
- **Full CRT** — all effects declared by the active theme, including explicitly
  opt-in flicker, jitter, scrolling texture, and noise.

For a sparse custom theme, a profile is enabled only when the theme can produce
that profile as a distinct canonical state; duplicate choices stay disabled.
Any individually tuned combination is labelled **Custom**. Selecting a profile
updates the same persisted toggles used by Settings; Settings remains the only
place for individual switches and effect parameters. Under
`prefers-reduced-motion: reduce`, continuous or flashing effects are disabled at
runtime even when saved on, the profile control communicates that motion is
paused by the system, and static scanlines/non-animated glow may remain. High
Contrast removes decorative blur, scanlines, and low-contrast roll overlays.
Flicker, jitter, and animated noise are never default-on.

The header uses its own inline-size container so UI scale participates in the
collapse decision. Shortcut hints and secondary action labels collapse at the
equivalent of roughly `61em` of header content, whether that limit is reached by
window width or 100–150% UI scale. The signal mark, full `EZTerminal` wordmark,
and current FX profile remain visible; the supported desktop shell must not
reduce the name to `EZT`. The mobile tab strip does not carry this cluster: it
exposes appearance through More and uses the full wordmark only in suitable
connection or empty-state surfaces.

## 8. Component system

The shared primitive contract consists of:

- `Button`, `IconButton`, and `SplitButton`;
- `Field`, `Input`, `Select`, and `Switch`;
- `Tabs`;
- `Menu` and `Popover`;
- `Dialog` and mobile `ActionSheet`;
- `PanelShell`;
- `Badge` and `Status`;
- `Tooltip`;
- `Toast`;
- `EmptyState`, `LoadingState`, and `ErrorState`;
- `VisuallyHidden`.

Each interactive primitive defines default, hover, active, keyboard-focus,
disabled, and loading states. Danger and selected states are variants of the
same primitive rather than one-off CSS classes. Icon-only controls always have
an accessible name and tooltip. Loading controls retain their label width and
announce state without becoming focus traps.

Composition components use these primitives:

- `AppHeader`, `BrandMark`, `EffectProfileMenu`, `ActivityRail`,
  `SidebarShell`, and `WorkspaceMenu`;
- `CommandCenter` and `QuickCommandShelf`;
- `ExplorerPanel`, `AgentsPanel`, `MonitorPanel`, `RemotePanel`,
  `OpenClawPanel`, and `SettingsPanel`;
- `MobileWorkbenchCoordinator`, `MobileHeader`, `MobilePageShell`, and
  `SheetDialogHost`.

All product icons come from `lucide-react` SVG components. Emoji, Unicode
symbols used as icons, icon-font glyphs, and mixed text-glyph controls are
removed. Lucide's ISC license is recorded in `THIRD_PARTY_NOTICES`.

## 9. Localization

Localization uses `i18next` and `react-i18next` with typed resources. English is
the canonical key shape; Korean must satisfy the same complete resource shape.
UI language preference is `system | ko | en`.

- `system` resolves to Korean when the first applicable browser language starts
  with `ko`; otherwise it resolves to English.
- `<html lang>` updates whenever the effective locale changes.
- The native Electron application menu refreshes to the effective locale.
- Korean and English use concise, formal product language.
- Dates, counts, and relative time use `Intl` with the effective locale.

Commands, command output, file paths, provider/product names, protocol fields,
status enums, persisted identifiers, and test IDs are not translated.

Desktop persists optional `locale`, `density`, and `sidebarWidth` fields in the
existing settings schema without incrementing schema version 1. Reads and
writes use one atomic desktop UI-preferences API so partial changes cannot
overwrite concurrent fields. Mobile preferences are local to the mobile device
and are not added to the paired-session protocol.

## 10. Custom-theme compatibility and contrast correction

The theme contract is:

```ts
interface UiThemeColors {
  canvas: string;
  surface: string;
  surfaceRaised: string;
  surfaceInset: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  borderSubtle: string;
  borderStrong: string;
  accent: string;
  onAccent: string;
  focus: string;
  info: string;
  success: string;
  warning: string;
  danger: string;
}

interface ThemeAdjustment {
  role: keyof UiThemeColors | 'terminalForeground' | 'terminalCursor';
  before: string;
  after: string;
  requiredRatio: number;
  achievedRatio: number;
}

interface ResolvedTheme {
  requestedId: string;
  effectiveId: string;
  theme: ThemeDefinition;
  adjustments: readonly ThemeAdjustment[];
  fallbackReason?: 'missing-custom-theme' | 'invalid-custom-theme';
}
```

`ThemeMod` becomes a discriminated union of the existing schema-version-1
shape and a schema-version-2 shape with explicit `ui` colors. Version 1 remains
readable indefinitely and is never silently rewritten. Its `--term-*`, xterm,
font, effect, and swatch data remain intact; known terminal values seed the UI
palette. Version 2 is the latest authoring format.

At runtime, functional color pairs are checked and minimally corrected when
needed. The source theme file and requested theme ID are preserved. Settings
and diagnostics show each effective before/after adjustment. A missing or
invalid requested custom theme keeps its requested ID but uses Matrix as the
effective fallback so restoring the file restores the user's choice.

Hard thresholds:

- normal text against its surface: 4.5:1;
- focus indicators, interactive borders, and functional icons against adjacent
  colors: 3:1;
- terminal foreground against background: 4.5:1;
- terminal cursor against background: 3:1.

All built-in themes pass these thresholds without runtime adjustment. Automated
tests hard-fail a built-in theme regression.

## 11. Core UX state contract

| Surface | Loading / progress | Empty | Error / offline | Success / focus outcome |
| --- | --- | --- | --- | --- |
| SidebarShell | Stable panel skeleton; no terminal resize loop | Destination-specific explanation and primary action | Inline recovery; narrow overlay remains dismissible | Selection persists; close returns invoker focus |
| Explorer | Bounded directory progress | Empty directory guidance | Permission/read/reconnect error with Retry | Selection opens existing safe preview flow |
| Agents | Snapshot skeleton; ages update without live announcements | No agent activity and integration shortcut | Hook/provider/offline guidance; no silent retry of input | Focus selects exact pane and restores terminal/composer focus |
| Monitor | Poll only while visible | No packets/stats yet | Classed collection error without blocking terminal | Live values update without layout shift |
| Remote | Pair/tunnel progress is explicit | No paired client/tunnel | Auth, lease, tunnel and offline failures are distinct | Successful state identifies the usable endpoint/session |
| OpenClaw | Native view loading belongs inside panel | Integration unavailable guidance | Recoverable load error; narrow overlay remains closable | Wide view reflows; narrow view owns occlusion |
| Settings | Local values render immediately | Not applicable | Save failure keeps edited value and offers Retry | Atomic preference save; focus remains on control |
| Command Center | Stale searches are discarded | Recent/useful actions or no-match message | Disabled result explains why | Explicit action closes only when its operation completes |
| Mobile auxiliary page | Terminal remains mounted underneath | Page-specific empty state | Offline/local capabilities are distinguished | Back reveals the same terminal instance |
| Dialog / ActionSheet | Duplicate submission disabled | Not applicable | Error remains within labelled surface | Close restores invoker unless action intentionally moves focus |
| Terminal paste safety | Clipboard read is a bounded user-initiated action | Empty or unavailable format gets a brief status notice | Read failure sends no PTY input; warning cancellation is silent | Confirmed text is delivered once; focus returns to the same terminal |

Toasts are reserved for brief completed feedback. Recoverable errors that need
action stay next to the failed operation. Skeletons preserve final geometry.

## 12. Accessibility hard gates

- Every flow is operable by keyboard alone on desktop and by touch plus Android
  Back on mobile.
- Visible focus meets 3:1 contrast and is never removed without an equivalent.
- Modal dialogs and Command Center trap focus; non-modal sidebars do not.
- The paste warning is an `alertdialog`; Cancel receives initial focus, Escape
  cancels without reaching the PTY, and close restores the exact invoker.
- A blocked Codex control key is announced at most once per run through the
  existing polite status-toast pattern; repeated keypresses do not spam assistive
  technology.
- Menus support Arrow keys, Home/End, Enter/Space, Escape, Shift+F10, and the
  Menu key where applicable, with deterministic focus restoration.
- Status, selection, error, and attention never rely on color alone.
- Live regions announce meaningful state transitions once; elapsed time,
  animation frames, retry countdown ticks, and stats polling are not announced.
- Labels, descriptions, errors, and disabled reasons are programmatically
  connected. Icons are hidden from accessibility APIs when adjacent text owns
  the meaning.
- Touch targets are at least 44×44px; desktop targets meet the selected density
  contract.
- Browser zoom is permitted, text survives 200% zoom, and layouts are verified
  at the required 150% product QA axis.
- Reduced motion disables moving CRT effects and nonessential transitions.
- Product Storybook stories use `parameters.a11y.test = 'error'`; unreviewed
  accessibility violations are release blockers.

### 12.1 Explorer interaction accessibility decision

The file Explorer uses the existing visual treatment and interaction outcomes,
with a delegated accessibility hardening decision. Three approaches were
considered:

1. Keep pointer-only `div` rows and add click handlers only — rejected because
   the rows remain absent from the keyboard and accessibility trees.
2. Make every actionable row a semantic button-equivalent, retain the custom
   cursor-positioned menu with the ARIA menu keyboard model, and render file
   preview through the shared modal `Dialog` primitive — selected. This keeps
   stable file actions and test identifiers while reusing the repository-owned
   focus trap and restoration contract.
3. Replace the Explorer with a tree/grid selection widget — rejected for this
   release because Explorer currently models immediate open actions rather than
   persistent selection, and the larger interaction rewrite would change its
   navigation contract.

Selected behavior:

- A file or directory row is one focusable action. Enter and Space open it;
  Shift+F10 and the Context Menu key open its existing item menu at the row.
- The context menu exposes `menu`/`menuitem` semantics, focuses its first item
  on open, wraps Arrow Up/Down, supports Home/End, activates with Enter/Space,
  closes with Escape, and restores the invoking row when appropriate.
- File preview is modal. It uses `Dialog` for `aria-modal`, focus containment,
  Escape dismissal, and invoker focus restoration. Existing preview actions,
  localized labels, and stable test IDs remain unchanged.
- Loading, file-read error, truncated-file, and successful preview content keep
  their current product states. This change adds no new token, asset, route,
  breakpoint, or localization-resource requirement.
- Verification is component-DOM keyboard/focus regression coverage plus the
  existing File Explorer browser E2E. The current mockups are reference-only;
  this document and repository primitives remain normative. Project-local
  Storybook and visual tooling remain governed by the broader release QA lanes
  in section 13.

## 13. Visual QA and automated coverage

Storybook 10.4 uses the React+Vite framework with addon-a11y and addon-vitest.
Stories cover every shared primitive and major shell/panel composition in
default, hover/focus where deterministic, disabled, loading, empty, error,
success, long-label, and overflow states.

Playwright provides deterministic `toHaveScreenshot()` baselines and
`@axe-core/playwright` page checks. Fonts, locale, timezone, device scale,
fixtures, animation, caret, and time-sensitive content are fixed in the visual
environment. Product accessibility errors hard-fail CI.

Required axes:

- desktop: 800×600, 1024×720, 1200×800, 1440×900;
- mobile: 360×800, 412×915, 600×960, 915×412;
- Matrix in Korean and English for all product stories;
- all built-in themes in a token/component gallery;
- adaptive, compact, and comfortable density where behavior differs;
- 100% and 150% scale;
- default and reduced motion;
- `BrandMark` in every built-in theme at full/compact desktop widths and at
  100%/150% scale;
- non-overlapping header controls at 800, 1024, 1200, and 1440px in both
  100% and 150% scale, with narrow sidebar overlays anchored to the actual
  workbench body rather than a fixed header-height guess;
- Matrix CRT Signature with real effect attributes at 1440px, 800px/150%, and
  reduced motion, using a deterministic animation phase for screenshots;
- sidebar closed/open, wide reflow/narrow overlay, and loading/empty/error
  panel states.
- Codex paste warning states for multiline, large, and combined risks, including
  Korean/English text, Cancel focus, and a deterministic Matrix-theme screenshot.

CI builds Storybook and runs its component/accessibility checks, desktop visual
tests, mobile typecheck/test/build/lint, and mobile visual tests in addition to
the existing desktop unit, integration, packaged Electron, and E2E lanes.

## 14. Migration and cleanup contract

Implementation order is:

1. semantic tokens, typography, effects, and shared primitives;
2. localization, desktop/mobile preferences, and theme resolution;
3. desktop shell, navigation, sidebar destinations, and settings;
4. mobile persistent coordinator, responsive header, pages, sheets, and CSS
   boundary;
5. Storybook, accessibility, screenshots, and CI;
6. remove legacy components/selectors only after reference searches are zero;
7. run the complete regression matrix.

During migration, adapters may preserve existing feature APIs, but new screens
must not fork business logic. `CommandPalette.tsx`, the obsolete
`FileViewerOverlay.tsx`, independent old drawers/rails, emoji icon controls, and
legacy CSS are deleted only when their live references are zero and equivalent
coverage exists.

The redesign is complete only when:

- the desktop header has exactly four zones;
- the full `EZTerminal` Signal Wordmark remains visible at every supported
  desktop width and the single FX utility controls the shared effect state;
- the activity rail and single responsive sidebar own all specified
  destinations without duplicates;
- desktop settings match the six approved categories;
- mobile terminal DOM identity survives every auxiliary-page round trip;
- both breakpoints expose the approved mobile actions and zero tabs remains
  navigable;
- all new chrome uses semantic tokens and Lucide icons;
- Korean/English, density, theme v1/v2 compatibility, contrast correction, and
  reduced motion meet this contract;
- old duplicate surfaces and unused code are removed;
- Storybook, axe, visual regression, desktop checks, mobile checks, packaged
  smoke, and full E2E all pass.

## 15. Version 1.0 release contract

Version 1.0 freezes the Adaptive Workbench direction and adds no new product
surface. Desktop and Android provide outcome parity for commands, terminal
sessions, files, agents, monitoring, theme, language, density, and connection
recovery. Parity does not mean pixel mirroring: desktop keeps keyboard-first
multi-pane controls, while Android uses touch-first pages and sheets and keeps
the terminal layer mounted beneath them.

The supported release surfaces are Windows 10 22H2/Windows 11 x64 at a minimum
window size of 800x600, and Android 10 (API 29) or newer. Android must be
verified at API 29 and API 35 plus a physical foldable device. The physical
device lane covers folded/unfolded layouts, portrait/landscape rotation,
display cutouts, the software keyboard, Android Back, and TalkBack.

API 29 verification includes its stock WebView 74 runtime, not only an updated
Play-system WebView. The compatibility bootstrap must run before React and
xterm, and the device lane must exercise forced-xterm pointer input, file
upload, theme-file import, and modal focus isolation.

Mobile safe-area ownership remains singular at the application root. Storybook
and browser fixtures must reproduce the same definite root-height chain rather
than changing the product workbench back to viewport ownership. Product scale
fixtures must call the real UI preference path and wait for a stable story-ready
signal before screenshots.

Every modal action sheet isolates all non-dialog application content from the
accessibility tree and focus order. Isolation is reference-counted so closing a
nested sheet cannot expose the background while another modal remains open.
All mobile interactive targets, including integration configuration fields,
remain at least 44x44 CSS pixels.

Plain `ws://` remains available for version 1.0 only through Tailscale,
WireGuard, or another explicitly trusted VPN interface; ordinary LAN binding is
rejected. Pairing and connection screens must present this warning before or
beside an endpoint; the warning is persistent guidance, not a transient toast.
TLS and certificate pinning are a post-1.0 protocol change.

Production builds contain no E2E-only observers, terminal-text extraction, or
`[ez-e2e]` diagnostics. Dedicated E2E builds may expose those probes. Visual
approval uses real product components and a final APK on device; mock shell
stories remain deterministic coverage but are not the sole release oracle.

Version 1.0 explicitly defers mobile split/layout presets, the global Command
Center, a complete desktop-settings mirror, full OpenClaw administration, a
standalone Android shell, Play Store distribution, and automatic updates.

## 16. Remote desktop control addendum

This addendum is normative for the first public remote-desktop-control release.
It adds a full Windows GUI control surface to the Android companion; it does not
implement or expose the Microsoft RDP protocol. The audience is an already
paired EZTerminal user who needs to operate the same Windows PC while away from
it over Tailscale, WireGuard, or another explicitly trusted VPN.

### 16.1 Direction decision

Three mobile information-architecture directions were evaluated:

1. **Auxiliary full-screen page — selected by the user.** `More > PC Control`
   opens an opaque page above the still-mounted terminal layer. This preserves
   terminal state, gives the remote video enough area, and follows the existing
   `MobileWorkbenchCoordinator`/Android Back model.
2. **Top-level header mode — rejected.** It makes PC control faster to reach but
   overloads the compact header and turns a secondary capability into primary
   navigation.
3. **Pseudo terminal tab — rejected.** It reuses tab chrome but falsely implies
   that a graphical desktop is a terminal session and complicates tab lifetime.

The desktop does not gain a new activity-rail destination. The existing Remote
panel owns service, VPN, pairing, and active-controller state. A non-dismissible
application-wide banner and the Windows tray provide the local safety affordance.

### 16.2 Screen and component inventory

- `MobileHeaderMoreActions` adds **PC Control**. It is disabled with a connected
  reason when the authenticated server does not advertise
  `desktop-control-v1`.
- `MobileRemoteDesktopView` is an auxiliary page containing
  `RemoteDesktopToolbar`, `RemoteVideoSurface`, connection-state overlay, and
  an action sheet for special keys, clipboard, quality, and diagnostics.
- The toolbar owns Back, device/status label, monitor selection, Trackpad/Direct
  mode, keyboard, overflow, and Disconnect. Landscape moves secondary controls
  into overflow but retains Back, mode, keyboard, and Disconnect.
- `RemoteVideoSurface` uses a video element with a separately composited remote
  cursor. It owns zoom/pan and maps pointer coordinates through the current
  fit/zoom/rotation transform.
- Trackpad is the persisted default input mode. One finger moves, tap clicks,
  double tap double-clicks, double-tap-and-hold drags, two fingers scroll, and
  two-finger tap right-clicks. Pinch changes client-side zoom.
- Direct mode maps one-finger contact to the remote absolute position; tap
  clicks, drag holds the left button, long press right-clicks, and pinch zooms.
- A hidden labelled text input owns Android IME composition. Committed text is
  sent as Unicode; physical keyboard events and special keys use scan codes.
- Clipboard actions are explicitly directional: **Send mobile text to PC** and
  **Copy PC text to mobile**. No clipboard read or write occurs on page entry,
  focus, reconnect, or background transition.
- `RemotePanel` adds a PC Control card for service health, trusted VPN adapter,
  UDP endpoint, current device, duration, fps, RTT, bitrate, edition limitations,
  and immediate Disconnect.
- `RemoteControlBanner` appears above the desktop workbench whenever control is
  active. It identifies the device and exposes Disconnect; it cannot be dismissed.
  The Windows tray mirrors idle/active/error state and exposes Open, Disconnect,
  and Quit.

All additions use repository primitives, semantic tokens, and Lucide icons. No
new raster illustration, remote font, normative Figma file, or generated image
is required. The existing app icon is the source for tray artwork.

### 16.3 State contract

| Surface | Loading / progress | Empty / unavailable | Error / offline | Success / cancellation |
| --- | --- | --- | --- | --- |
| Mobile PC Control entry | Capability status follows authenticated bridge state | Missing service, unsupported peer, or untrusted VPN has a connected disabled reason | Auth/protocol failure uses existing connection recovery | Opens one auxiliary page without remounting Terminal |
| Remote desktop page | `starting` and ICE connection show a stable video-size skeleton | No display/encoder and Windows-edition limits identify the exact missing capability | `reconnecting` freezes the last frame; timeout, UDP block, service failure, and controller busy are distinct | `active` announces once; Disconnect and Android background release input immediately |
| Video surface | Initial frame and monitor switch retain final geometry | Not applicable while a display exists | Capture loss retries within the active lease and exposes Retry/Disconnect after terminal failure | Monitor change forces a keyframe without resetting client zoom preference |
| Input | Sticky modifiers and drag state are visibly pressed | Ctrl+Alt+Del is disabled with a Home/policy reason | Rejected input does not retry or leave keys pressed | Every stop path releases remote keys/buttons and restores toolbar focus |
| Clipboard sheet | One bounded user action may show progress | Empty/unavailable text produces polite status | Permission, secure-desktop, and size errors send/write nothing | Completed direction gets one toast; Cancel has no side effect |
| Desktop PC Control card | Service and session startup are explicit | Bridge off, service missing, no trusted VPN, and idle are distinct | Native crash, UDP collision, and capture/encoder errors keep remediation beside status | Active state identifies device and local Disconnect wins immediately |
| Banner / tray | Not applicable | Hidden/inactive when there is no controller | Error state remains in Remote panel, not a stale active banner | Active banner/tray survive panel navigation and disappear only after release |

Only one Android controller may hold the lease. A second device sees the current
device name and `busy`; it cannot force takeover. The current controller or the
local desktop must disconnect first. A transport interruption suspends input at
once and gives the same installation ID a 15-second resume window. Android
backgrounding is an explicit stop rather than a hidden resume window.

### 16.4 Responsive, input, and accessibility contract

- Required mobile viewports remain 360x800, 412x915, 600x960, and 915x412.
  The remote page has no document scroll; the video viewport clips its own
  transformed surface and toolbar/overflow own their scrolling.
- Every toolbar and sheet target is at least 44x44 CSS pixels and survives
  Korean/English labels, display cutouts, safe areas, software keyboard resize,
  200% text zoom, and portrait/landscape rotation.
- Android Back closes, in order: IME/special-key/clipboard sheet, toolbar
  overflow, remote page, then the platform default. Leaving the page returns to
  the exact mounted terminal instance and usable focus.
- Connection state, input mode, selected monitor, sticky modifiers, busy/error,
  and Ctrl+Alt+Del availability never rely on color alone. State transitions use
  one polite live region; fps, elapsed time, cursor movement, and retry ticks are
  never live-announced.
- The video surface has a localized accessible name and concise gesture
  instructions. Toolbar alternatives expose keyboard, monitor, clipboard, and
  disconnect operations without requiring a canvas gesture.
- Reduced motion removes nonessential toolbar/overlay transitions. Remote video
  itself is user-requested content and is not paused by reduced-motion settings.
- Desktop banner controls are keyboard reachable, visibly focused, and do not
  steal focus when a session starts. Tray labels are localized through the same
  effective-locale source as the native menu.

### 16.5 Visual oracle and freshness

Storybook owns deterministic disconnected, unavailable, starting, active,
reconnecting, busy, Home-limited, error, special-key, clipboard, portrait, and
landscape states using fake `MediaStream`/controller adapters. Playwright owns
the existing desktop/mobile screenshot axes, Korean/English, Matrix/reduced
motion, banner presence, 150% scale, and mobile Back/focus behavior. Product
Stories set `parameters.a11y.test = 'error'`.

No installed readiness detector exists, but this repository already has
Storybook and screenshot regression configuration; those project-local lanes
remain required. Mock streams and stories are deterministic reference fixtures,
not the release oracle. Final approval requires a packaged Windows app and APK
on API 29/API 35 plus a physical device over a real VPN. This addendum and the
repository primitives are normative; screenshots must be refreshed whenever
this interaction contract or the relevant tokens/components change.

There are no unresolved appearance, navigation, responsive, asset, or
accessibility decisions for this feature.
