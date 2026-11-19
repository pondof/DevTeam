---
name: contract-change
description: "devteam contract change: handle a task that returned needs_contract_change (or blocked on a missing file or dependency). The architect amends the frozen contract and plan on the epic branch, dependent tasks are re-briefed and rebuilt. Use whenever an engineer asks for an API/event/DB contract change mid-build."
allowed-tools:
  - Read
  - AskUserQuestion
  - Agent(devteam:architect, devteam:integrator)
  - Workflow
  - Workflow(devteam:build)
  - Bash(devteam *)
  - Bash(git log*)
  - Bash(git diff*)
---

# devteam: contract-change

1. Read the request: `<RUN>/tasks/<id>/report.json` → `contract_change_request`, `deps_requested`, `open_questions`.
2. Decide the kind:
   - **Contract change** (field, endpoint, status code, event): it affects other roles. If it changes behaviour the human approved at checkpoint 2 (not just a missing detail), ask them first with one AskUserQuestion. Otherwise make a ruling and record it in the ledger.
   - **Missing file in the task's list**: plan-only change. Extend `files` for that task in plan.json, as long as it stays inside the role's ownership and does not collide with a parallel task.
   - **Dependency in a hot file**: dispatch `devteam:integrator` with `mode=prep` and the dependency list.
3. For a contract change, dispatch `devteam:architect` with `DEVTEAM run=<RUN> task=- role=architect mode=revise` and the exact request. It amends `packages/contracts`, commits on the epic branch, updates `plan.json` (affected tasks' notes/files, plus new tasks if needed) and re-runs `devteam plan check`.
4. Find the tasks the change affects: the requester, plus every task whose `contract_refs` or files touch the changed part. For tasks that already merged, add a follow-up task instead of reopening them.
5. `devteam task reset "$RUN" <affected not-yet-merged ids>` when their previous work is invalid; otherwise leave them, and they resume from their last commit.
6. `devteam run ledger "$RUN" contract "<what changed> — requested by <id>"`, then `devteam run args "$RUN" build --tasks <ids>` → **Workflow** `devteam:build`.
