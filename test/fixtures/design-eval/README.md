# Design-context agent evaluation

These fixtures measure whether reading the root visual contract improves a UI implementation. They are evaluation inputs, not a second design specification, and their patches must never be merged without normal product review.

## Controlled run

1. Start from a clean source commit and record its SHA.
2. Create two detached temporary worktrees at that same SHA: `baseline` and `treatment`.
3. Run the same case prompt with the same model, reasoning setting, tool permissions, and time budget in both worktrees.
4. For the controlled baseline only, explicitly withhold `DESIGN.md`. This is an evaluation-only exception to the repository UI workflow; do not use it for product work.
5. For the treatment, require the agent to read `DESIGN.md` before inspecting implementation files. Let both candidates discover any other repository context normally.
6. Run the case's requested checks in each worktree. Save the final patch, check output, and a short decision log outside both worktrees.
7. Relabel the artifacts `A` and `B`, randomize their order, and have a reviewer score both with `rubric.md` without knowing the condition.
8. Remove the temporary worktrees after the artifacts are retained. Do not merge either evaluation branch.

Example setup, with paths chosen outside the product checkout:

```powershell
$sourceSha = git rev-parse HEAD
git worktree add --detach C:\Temp\ezterminal-design-eval\baseline $sourceSha
git worktree add --detach C:\Temp\ezterminal-design-eval\treatment $sourceSha
```

## Interpretation

Treat a single run as directional evidence. Prefer the contract only when the treatment repeatedly improves rubric scores without increasing regressions, unnecessary scope, or validation failures. If both candidates make the same mistake, improve the production seam or the task fixture before adding more prose to `DESIGN.md`.

Do not update snapshots merely to make a candidate pass. Review actual and expected images side by side, and keep performance measurement outside this evaluation unless it is separately requested.
