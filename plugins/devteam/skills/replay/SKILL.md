---
name: replay
description: "devteam replay: re-run one or more tasks of an existing run from their saved briefs, either continuing from the last attempt or fresh from the epic branch. Use to retry a task that failed review, hit a merge conflict, or to reproduce a task failure for debugging."
allowed-tools:
  - Read
  - AskUserQuestion
  - Workflow
  - Workflow(devteam:build)
  - Bash(devteam *)
  - Bash(git log*)
---

# devteam: replay

1. Identify the run (`devteam run status`) and the task ids.
2. Choose how to restart:
   - **Continue** (default after review_failed): keep the previous attempt's commit, so the next engineer resumes from it.
   - **Fresh** (after a merge conflict, or when the approach was wrong): `devteam task reset "$RUN" <ids...>`, so the next start begins from the current epic branch.
3. If the plan itself was wrong for that task (files, role, acceptance), fix `plan.json` first and run `devteam plan check "$RUN"`.
4. `devteam run args "$RUN" build --tasks <ids,comma-separated> --redo --final false` → **Workflow** `devteam:build`. Add `--overflow` to let Gemini take a `low_risk` task.
5. `devteam run collect "$RUN" --prune` and report the result in ≤ 5 lines.

## Reporting
Report only from the Workflow result and `devteam run status`. Never describe results, counts or merges before the Workflow tool has returned. While it runs there is nothing to report yet.
