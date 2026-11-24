---
name: status
description: "devteam status: show the active (or a named) run, including tasks by wave and state, gate results, attempts, engine split, the ledger tail, live worktrees and the epic branch log. Use when the user asks what the team is doing, what happened in a run, or after a compaction or restart."
allowed-tools:
  - Read
  - Bash(devteam *)
  - Bash(git worktree list*)
  - Bash(git log*)
  - Bash(git branch*)
---

# devteam: status

1. `devteam run status [<run id or path>]` (no argument = the current run).
2. `git worktree list` (task worktrees still alive) and `git log --oneline -12 <epic branch>`.
3. If the user asks about one task: read `<run>/tasks/<id>/state.json`, `report.json`, the `review-*.json` files and `wt-gates.json` (copied by `devteam run collect`). Explain in plain words what happened and what the next step is.
4. Answer in ≤ 10 lines. Point to files instead of pasting them.
