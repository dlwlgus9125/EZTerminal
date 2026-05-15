---
doc_type: reference
authority: canonical
status: active
---

# Settings Persistence Contract

User settings persistence for EZTerminal.

## File Location

`%APPDATA%/EZTerminal/settings.json`

Resolved via `electron.app.getPath('userData')`.

## Write Strategy

Atomic write to prevent corruption:
1. Serialize to JSON with 2-space indent
2. Write to `settings.json.tmp` in same directory
3. `fs.renameSync('settings.json.tmp', 'settings.json')` (atomic on NTFS)
4. On rename failure: log error, `.tmp` file remains for recovery

## Schema

See `docs/reference/schema.md` Settings interface for the full type definition.

### Defaults

| Field | Default | Constraint |
|-------|---------|------------|
| `version` | 1 | Monotonically increasing |
| `shell.path` | `""` (empty = auto-detect) | OS default: PowerShell → cmd fallback |
| `font.family` | `"Consolas"` | Must be monospace |
| `font.size` | 14 | Range: 8–32 |
| `colorScheme` | `"dark"` | Currently only "dark" |
| `monitoring.cpuInterval` | 1 | Min: 1 second |
| `monitoring.diskInterval` | 5 | Min: 1 second |
| `monitoring.processInterval` | 5 | Min: 1 second |
| `monitoring.packetBufferSize` | 1000 | Min: 100 |

## Load Behavior

1. Read `settings.json` from `userData` path
2. Parse JSON
3. Validate against schema: clamp out-of-range values, fill missing fields with defaults
4. On parse failure (corrupt file): log error, return full defaults, do NOT overwrite corrupt file (preserves for debugging)

## Migration

Settings `version` field tracks schema version:
1. On load, check `version` against current schema version
2. If older: run migration functions sequentially (v1→v2, v2→v3, etc.)
3. Each migration adds new fields with defaults, never removes fields
4. Save migrated settings immediately after successful migration

## Validation Rules

| Field | Rule |
|-------|------|
| `font.size` | Clamp to [8, 32] |
| `monitoring.cpuInterval` | Clamp to [1, 60] |
| `monitoring.diskInterval` | Clamp to [1, 300] |
| `monitoring.processInterval` | Clamp to [1, 300] |
| `monitoring.packetBufferSize` | Clamp to [100, 10000] |
| `shell.path` | Validate existence on PTY create, not on save |
