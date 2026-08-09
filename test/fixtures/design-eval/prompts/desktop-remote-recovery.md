# Desktop remote recovery

## Objective

Add a production-ready desktop Remote state for a workstation that was reachable but can no longer start screen control. The operator must understand what stopped, retain the selected workstation context, retry safely, and reach useful diagnostics without leaving the workbench.

## Constraints

- Extend the existing Remote composition and production component seams.
- Do not invent a successful connection, device, permission, or server response.
- Preserve keyboard operation, Korean and English copy paths, all built-in themes, reduced motion, and the supported 800px desktop width.
- Keep the implementation scoped to this recovery state; do not redesign unrelated workbench navigation.

## Completion evidence

- Add a deterministic production-backed Storybook state.
- Add focused behavior tests for retry and diagnostics actions.
- Demonstrate no horizontal overflow and no WCAG 2.1 A/AA violations in the story.
- Run the repository document, style, type, unit, and Storybook checks relevant to the change.
