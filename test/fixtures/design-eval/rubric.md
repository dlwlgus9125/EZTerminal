# Blind review rubric

Score each category from 0 to 2 using the current `DESIGN.md`, `docs/ux/frontend-design.md`, production tokens/components, and rendered evidence as the authorities. Do not score from memory or from this rubric alone.

| Category | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Product identity | Generic or contradictory | Partly recognizable | Clearly belongs to EZTerminal without decoration overload |
| Information hierarchy | Important state/action is obscured | Usable with minor ambiguity | Current task, state, and next action scan clearly |
| State and recovery | Missing or invented behavior | State exists but recovery is weak | Cause, impact, and safe recovery are concrete |
| Token and component fit | Bypasses established seams | Mixed reuse and local invention | Uses semantic tokens and production primitives cleanly |
| Platform expression | Wrong interaction anatomy | Mostly platform-appropriate | Preserves shared identity with native desktop/mobile behavior |
| Accessibility and resilience | Blocking violations | Minimum checks pass with gaps | Focus, semantics, locale, density, motion, and overflow hold |
| Evidence quality | No reliable proof | Narrow or unstable proof | Deterministic production-backed story/tests prove the change |
| Scope and maintainability | Duplicates authority or sprawls | Some avoidable complexity | Small coherent change with clear ownership |

Record validation failures separately; they cannot be offset by visual preference. Also note any direct palette literals, terminal tokens used for application chrome, local font stacks, arbitrary z-index ladders, fabricated success data, or snapshot updates that were not visually reviewed.

Maximum score: 16. Report category scores, validation results, observed regressions, and a short confidence statement. Compare the anonymized candidates only after both have been scored independently.
