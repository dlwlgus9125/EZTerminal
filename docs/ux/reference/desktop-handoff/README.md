# Desktop handoff source set

`manifest.json` is the tracked index for the desktop handoff package. The
canonical prototype is `EZTerminal-desktop-prototype.dc.html`; its required
`support.js` import is preserved as supporting import closure so the canonical
source can be audited completely.

`EZTerminal-desktop-options.dc.html` is option-history evidence only. It is a
historical non-acceptance source: it may explain alternatives that were
considered, but it cannot define or override current product acceptance.
`HANDOFF-README.md` owns implementation and QA guidance, while the fourteen
numbered PNG files are visual references mapped to product stories by the
manifest.

All 19 package source files are byte-pinned by SHA-256. Do not edit the pinned
copies; update the manifest and acceptance contract deliberately if a new
handoff supersedes them.
