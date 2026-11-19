---
name: feature
description: "devteam full feature flow with three human checkpoints: spec (product analyst) → design + frozen contracts + task DAG (architect, threat model, Gemini design review) → parallel build in isolated worktrees with reviews, merge queue, system QA and final cross-model review → PR. Use when the user asks the team to build a feature or any change that crosses roles, changes an API contract, or adds a dependency."
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - Workflow
  - Workflow(devteam:design)
  - Workflow(devteam:build)
  - Agent(devteam:product-analyst, devteam:architect, devteam:integrator)
  - Bash(devteam *)
  - Bash(devteam-agy *)
  - Bash(git status*)
  - Bash(git log*)
  - Bash(git diff*)
  - Bash(git push -u origin team/*)
  - Bash(gh pr create *)
---

# devteam: feature

You are the orchestrator for a full feature. Follow these steps in order. Keep chat output short: the run directory holds the detail.

## 0. Preconditions
- `devteam lint --project` must have no errors. If `.team/config.json` is missing, stop and suggest `/devteam:init`.
- `git status --porcelain` must show no tracked changes in the main checkout (untracked is fine). If it does, ask the human to commit or stash first.
- If the request is small (one role, a few files, no contract change), suggest `/devteam:quick` instead and let the human choose.

## 1. Start the run and map the repo
- `RUN=$(devteam run new <short-slug>)`. Use this absolute path everywhere below.
- Start the repo map **in the background** (Bash `run_in_background: true`): `devteam-agy map`. It writes `.team/context/map.md` (cheap, on the Google quota). Don't wait for it; it only has to finish before the design step.

## 2. Spec → CHECKPOINT 1
- Dispatch `devteam:product-analyst` (Agent tool) with: the run dir, the human's request verbatim, and "write <RUN>/spec.md".
- Read `<RUN>/spec.md` and show the human: the problem in one line, the acceptance criteria list, the out-of-scope list, and open questions with their proposed defaults.
- AskUserQuestion: **Approve spec** / **Revise** (they say what) / **Cancel**. On revise, re-dispatch the analyst with the feedback. Loop until approved.
- `devteam run ledger "$RUN" checkpoint "spec approved"`.

## 3. Design → CHECKPOINT 2
- `devteam run epic "$RUN"` (creates or switches to `team/<slug>` in the main checkout).
- Make sure the map finished (or failed: that's fine, design works without it).
- `devteam run args "$RUN" design` prints a JSON object. Call **Workflow** with `name: "devteam:design"` and `args` set to **that object** (pass it as a JSON object, not a string).
- On return: run `devteam plan check "$RUN"` (prints waves) and `git diff --stat <base>...HEAD -- packages/contracts`. Show the human:
  - the design summary (≤ 6 lines), tasks per wave (who works in parallel), contract changes (stat), new dependencies;
  - the blocking findings from the threat model and the Gemini design review, if any, plus a recommendation.
- AskUserQuestion: **Build it** / **Revise design** (with what to change) / **Cancel**. On revise: `devteam run args "$RUN" design --feedback "<what to change, including blocking findings>"` and run the design workflow again.
- `devteam run ledger "$RUN" checkpoint "design approved"`.

## 4. Build (runs without stopping)
- `devteam run args "$RUN" build` → call **Workflow** `devteam:build` with that object as `args`.
- If the human mentioned the Claude limit is close, add `--overflow` to route `low_risk` tasks to Gemini.
- On return:
  - `devteam run collect "$RUN" --prune` and `devteam run cleanup "$RUN"` (removes merged task branches), then `devteam run status "$RUN"`.
  - **blocked / needs_contract_change**: follow `/devteam:contract-change` for those tasks, then rebuild only them: `devteam run args "$RUN" build --tasks T3,T5`.
  - **review_failed / merge_conflict / merge_gate_failed**: show the diagnosis in two lines and offer `/devteam:replay <task>` (fresh attempt), or a ruling (accept with known issues, recorded in the ledger).
  - **skipped**: these re-run automatically on the next build call once their dependencies merge.
  - **final**: QA failures or critical/major final findings: create bugfix tasks (`/devteam:bugfix`) or let the human accept them. Don't start checkpoint 3 with an unresolved critical finding unless the human explicitly accepts it.
- Record rulings: `devteam run ledger "$RUN" ruling "<what> — <why> — <cost if wrong>"`.

## 5. PR → CHECKPOINT 3
- Dispatch `devteam:integrator` with `DEVTEAM run=<RUN> task=- role=integrator mode=pr` to write `<RUN>/pr.md`.
- Show the human: tasks merged, test/QA status, final review verdicts, open risks, and `git log --oneline <base>..team/<slug> | head -20`.
- AskUserQuestion: **Push and open PR** / **Keep local** (they review the branch themselves) / **More changes**.
- Only on an explicit yes: `git push -u origin team/<slug>` then `gh pr create --base <base> --head team/<slug> --title "<title>" --body-file "$RUN/pr.md"`. Report the PR URL. The human merges it.
- `devteam run ledger "$RUN" checkpoint "PR opened <url>"` (or "kept local").

## Recovery
After a compaction, a restart, or a usage-limit pause: `devteam run status` first. Merged tasks are skipped automatically on the next build call (`done` in the args). The Workflow tool can also resume a stopped run with `resumeFromRunId`.

## Reporting
Report only from the Workflow result and `devteam run status`. Never describe results, counts or merges before the Workflow tool has returned. While it runs there is nothing to report yet.
