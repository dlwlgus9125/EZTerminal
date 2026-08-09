# Dangerous session close

## Objective

Make closing a session with an active process safer on desktop and mobile. The confirmation must identify the affected session and consequence, make cancellation the safe default, and still let an informed user complete the close.

## Constraints

- Reuse the current session-close command and shared confirmation primitives.
- Do not add a second close workflow or store a fake process state.
- Preserve keyboard and touch behavior, focus restoration, Korean and English copy paths, all built-in themes, and reduced motion.
- Desktop and mobile may use different interaction anatomy while expressing the same risk and outcome.

## Completion evidence

- Add deterministic production-backed stories for both platforms.
- Add tests for initial focus, cancel, Escape or Back, confirm, and focus restoration.
- Demonstrate no horizontal overflow and no WCAG 2.1 A/AA violations at the narrow supported desktop and mobile widths.
- Run the repository document, style, type, unit, Storybook, and visual checks relevant to the change.
