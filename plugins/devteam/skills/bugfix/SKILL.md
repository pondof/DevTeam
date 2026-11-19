---
name: bugfix
description: "devteam bugfix: a debugger reproduces the bug with a failing test in an isolated worktree and finds the root cause, then the owning engineer fixes it from that commit, with review and merge. Use when something is broken and the cause is not known yet, including QA failures from a feature run."
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - Workflow
  - Workflow(devteam:build)
  - Bash(devteam *)
  - Bash(git status*)
  - Bash(git log*)
  - Bash(git diff*)
---

# devteam: bugfix

1. Collect the bug: observed vs expected behaviour, steps, error output. If any of these are missing and can't be inferred, ask the human **one** question.
2. Run:
   - New bug: `RUN=$(devteam run new fix-<slug>)` and `devteam run epic "$RUN"`.
   - QA failure inside a feature run: reuse that run and its epic branch, and add a new task id (`B1`, `B2`, …) to its plan.json.
3. **Guess the owner and area** from the map, `devteam config` and a quick grep. `files` may be a directory glob inside the owner's ownership (`apps/api/src/routes/**`) plus the test file path, because the exact fix location is unknown yet.
4. Write the task to `<RUN>/plan.json`:
   ```json
   {"epic": "<slug>", "size": "s", "tasks": [{"id": "T1", "title": "<bug in one line>", "role": "<owner>",
     "files": ["apps/api/src/routes/**", "apps/api/src/routes/projects.test.ts"],
     "acceptance": ["A test reproducing the bug fails before and passes after", "No regression: gate green"],
     "risk": [], "notes": "<observed vs expected, steps, error output>"}]}
   ```
   Then run `devteam plan check "$RUN"`.
5. `devteam run args "$RUN" build --mode bugfix` (add `--tasks B1` for a task inside a feature run) → **Workflow** `devteam:build`.
6. Read `reproduction` in the result:
   - `not_reproduced`: show the evidence and ask the human for more detail.
   - The debugger names a different `owner_role`: update the task's role and files in plan.json, `devteam plan check`, `devteam run args ... --redo`, and run the build again. The owner resumes from the debugger's failing-test commit automatically.
7. `devteam run collect "$RUN" --prune` and `devteam run cleanup "$RUN"` and `devteam run report "$RUN"` (writes `<RUN>/report.md` for the human), then report in ≤ 5 lines: root cause, fix, test, branch. Then offer push/PR as `/devteam:quick` does.

## Reporting
Report only from the Workflow result and `devteam run status`. Never describe results, counts or merges before the Workflow tool has returned. While it runs there is nothing to report yet.
