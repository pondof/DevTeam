---
name: review
description: "devteam review: multi-lens review of a branch, PR range or the whole repo. Lenses are code review, security review with deterministic scanners (gitleaks, osv-scanner, semgrep), and a Gemini cross-model review; every critical/major finding then goes through an adversarial refutation check. Use when the user asks the team to review or audit code."
allowed-tools:
  - Read
  - Write
  - AskUserQuestion
  - Workflow
  - Workflow(devteam:review)
  - Bash(devteam *)
  - Bash(git rev-parse*)
  - Bash(git rev-list*)
  - Bash(git log*)
  - Bash(git diff*)
  - Bash(gh pr view*)
  - Bash(gh pr diff*)
---

# devteam: review

1. Work out the range:
   - **Branch**: `base` = the base branch (`devteam config`), `head` = the branch.
   - **PR number**: `gh pr view <n> --json baseRefName,headRefName`, and make sure the head branch exists locally.
   - **Whole repo audit**: `mode audit`, `base` = `$(git rev-list --max-parents=0 HEAD | tail -1)`, `head` = `HEAD`.
2. `RUN=$(devteam run new review-<slug>)`.
3. `devteam run args "$RUN" review --base <base> --head <head> [--mode audit] [--focus "<what the human cares about>"]` → **Workflow** `devteam:review` with that object as `args`.
4. Write `<RUN>/review.md`: confirmed findings, most severe first (severity, file:line, issue, fix, which lenses found it), then the refuted findings in one line each, then minor findings.
5. Tell the human: counts by severity, the top 3 findings in one line each, and the path to `review.md`. Offer `/devteam:quick` or `/devteam:bugfix` per finding. Nothing gets changed without their go-ahead.

## Reporting
Report only from the Workflow result and `devteam run status`. Never describe results, counts or merges before the Workflow tool has returned. While it runs there is nothing to report yet.
