# Mobile agent history recovery

## Objective

Improve the mobile Agent history experience when a saved session can be read but its original project root is no longer available. The user must be able to distinguish history viewing from session resumption, select an allowed replacement folder, or leave without losing context.

## Constraints

- Use the existing mobile page, sheet, history, and folder-picker production seams.
- Never imply that the unavailable root or a resumed session exists before the transport confirms it.
- Preserve Android back behavior, focus return, touch targets, safe areas, Korean and English copy paths, and all built-in themes.
- Keep terminal content and application chrome semantically separate.

## Completion evidence

- Add deterministic production-backed stories for the unavailable-root and folder-selection states.
- Add focused tests for Back, cancel, invalid selection, and confirmed selection.
- Demonstrate no horizontal overflow and no WCAG 2.1 A/AA violations at 360px and 412px widths.
- Run the repository document, style, type, unit, Storybook, and mobile build checks relevant to the change.
