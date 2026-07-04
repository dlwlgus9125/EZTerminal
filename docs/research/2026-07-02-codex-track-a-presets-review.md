# Codex Gate — Track A ③ Layout Presets & Persistence (A-M0)

> Date: 2026-07-02 · Input: `docs/design/layout-persistence-design.md` (pre-gate draft, commit 8538c47)
> Runner: codex-companion task, read-only adversarial review
> **Verdict: REVISE — 6 blockers.** Direction viable; design overclaimed dockview rollback
> safety and left restore/save/quarantine races unresolved. All blockers folded back into
> the design doc before A-M1 (see "Resolution" lines).

## Blockers

**B1.** F4 is overbroad: `fromJSON` calls `clear()` at `dockviewComponent.js:1932`, then can
throw on malformed `data`/`grid.root` at `1933-1938` — **before** the revert `try/catch`
begins (starts at `1940`; revert covers `2050-2110`). The draft schema allowed
`grid.root: z.unknown()`.
Required change: pre-validate the minimal dockview root shape before calling `api.fromJSON`,
and for preset apply keep a current-layout backup instead of relying on revert-on-throw.
→ **Resolution: folded — design §3 root-shape schema + §6 restore pipeline (backup & pre-validate).**

**B2.** Restore/apply is not a serialized transaction. App runs under StrictMode
(`src/renderer/main.tsx:11-14`); `DockviewReact` calls `onReady` from an effect and disposes
the API in cleanup (`dockview-react/.../dockview.js:84-153`); the draft started an async
restore in `onReady` with no generation/cancel guard.
Required change: App-level restore/apply generation token, ignore stale async completions,
suppress saves during restore/fallback, register the save listener only after restore settles.
→ **Resolution: folded — design §6 "restore transaction" protocol.**

**B3.** Corrupt-layout fallback races quarantine against saving the new default layout
(dockview layout events are microtask-buffered, `events.js:279-289`).
Required change: await quarantine, suppress saves until it completes, then create/save the
fallback layout.
→ **Resolution: folded — design §6 (quarantine is awaited inside the restore transaction,
save listener attaches after).**

**B4.** `edgeGroups` not stripped (only floating/popout were). `SerializedDockview` includes
`edgeGroups` (`dockviewComponent.d.ts:105-109`); core deserializes them and auto-creates
groups/panels (`dockviewComponent.js:2031-2034`, `2141-2180`).
Required change: strip/reject `edgeGroups` on save and load; validate all restored panels
live in the primary grid.
→ **Resolution: folded — design §3 sanitizer strips floating/popout/edge buckets.**

**B5.** Main-side validation too loose for a filesystem-owning layer: `layout:save` accepted
raw `SerializedDockview`; schema allowed arbitrary `contentComponent`/`renderer` +
passthrough panel data. React throws on unknown components (`react.js:115-122`).
Required change: validate app-owned invariants in main — panels record key === panel `id`,
`contentComponent === 'terminal'`, renderer normalized to `always`, params absent/empty,
no unsupported serialized feature buckets, bounded panel count.
→ **Resolution: folded — design §3 strict panel schema + §4 main-side validation rules
(MAX_PANELS=64 bound).**

**B6.** §8 e2e plan didn't prove several claimed guard properties (only generic-garbage
corruption + sessionId-differs). Missing: `params.sessionId` rejection, early `grid.root`
invalidation, `edgeGroups` handling, unknown-component handling, reseed collision
prevention (assert next id === `tab-(max+1)` via `__ezDock`), leaked sessions after preset
apply. `TerminalPane` has no `data-session-id` yet; IPC exposes no session count.
Required change: targeted corrupt-shape tests + deterministic session lifecycle seam.
→ **Resolution: folded — design §8 e2e matrix (7 corruption shapes) + `data-session-id`
attribute + `window.__ezSessions` count seam.**

## Answers to the 5 open questions (§10 of the draft)

1. **F3 mount-path equivalence:** holds for plain `api.fromJSON(layout)` (no options);
   `defaultRenderer` does not bypass mounting. NOT universal: `reuseExistingPanels`
   (`dockviewComponent.js:1891-1931`) reuses live panels instead of remounting — the design
   must never pass it for startup restore (no live panels anyway) and must decide explicitly
   for preset apply (decision: do NOT use it in v1 — preset apply = full teardown, fresh
   sessions, simple semantics).
2. **beforeunload vs will-quit:** keep `beforeunload` best-effort; explicitly accept the
   300ms loss window for normal quit in v1 (documented), OR add a main-owned close-time
   flush handshake with timeout later. v1 decision: accept + document; the debounce plus
   best-effort flush bounds loss to sub-300ms edits.
3. **Strict-empty params:** acceptable for schema v1 (deliberate version bump for future
   params). Strengthened: also require `contentComponent === 'terminal'` so params can't
   re-enter via an unknown component type.
4. **Reseed regex vs UUIDs:** regex sufficient; duplicate `addPanel` ids throw
   (`dockviewComponent.js:2412-2416`) which is why reseed is mandatory. UUIDs deferred —
   no v1 benefit.
5. **Startup pref location:** `settings.json` (main-owned, same envelope pattern), NOT
   `presets.json` — avoids a Stage E1 migration.

## Additional findings

- Multi-window: declare layout persistence **single-window-only for v1** (folded into design §0).
- Windows atomicity: define stale-tmp cleanup, rename-failure handling, and quarantine
  overwrite policy (folded into design §4).
- Corrupt-fallback e2e must target specific corruption shapes, not just garbage (folded §8).
- Reseed e2e must assert the next minted id, not just "no crash" (folded §8).

## Verified-facts audit (F1–F6)

| # | Status | Note |
|---|--------|------|
| F1 | CONFIRMED | `dockviewPanel.js:142-156` |
| F2 | CONFIRMED | `deserializer.js:24-30` |
| F3 | PARTIALLY CONFIRMED | plain-path holds; `reuseExistingPanels` alternate path excluded by design decision |
| F4 | PARTIALLY CONFIRMED | revert exists but malformed input throws after `clear()` pre-try → B1 |
| F5 | CONFIRMED | no params; sessionId in component state only |
| F6 | CONFIRMED | reseed mandatory (dup ids throw) |
