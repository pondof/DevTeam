---
name: quick
description: "devteam quick path for small changes: one task, one role, a few files, no contract change, no new dependency. One engineer in an isolated worktree, gate, review, merge onto a team/ branch, then the human decides push/PR. Use for small fixes, copy changes, a single endpoint or component tweak."
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
  - Bash(git push -u origin team/*)
  - Bash(gh pr create *)
---

# devteam: quick

1. **Check it really is quick.** If it needs a contract change, a new dependency, or more than one role, switch to `/devteam:feature` and tell the human why in one line. The main checkout must have no tracked changes.
2. `RUN=$(devteam run new <slug>)`, then `devteam run epic "$RUN"`.
3. **Pick the role and files.** Use `.team/context/map.md` if it exists, and `devteam config` for ownership. Grep or glob to find the exact files; do not read whole modules. Files must sit inside one role's ownership.
4. **Write `<RUN>/plan.json`** with the Write tool (schema: `devteam schema plan`):
   ```json
   {"epic": "<slug>", "size": "s", "tasks": [{"id": "T1", "title": "...", "role": "<role>",
     "files": ["path/a.ts", "path/a.test.ts"], "acceptance": ["Given ... When ... Then ..."],
     "risk": [], "notes": "what to change and how to verify it"}]}
   ```
   Add `risk` tags honestly (auth, input, deps, infra, crypto, pii, secrets, payments, migration). They route the security, data and Gemini review lenses.
5. `devteam plan check "$RUN"` must pass.
6. `devteam run args "$RUN" build --mode quick` → **Workflow** `devteam:build` with that JSON object as `args`.
7. On return: `devteam run collect "$RUN" --prune` and `devteam run cleanup "$RUN"` (removes merged task branches), then report in ≤ 5 lines: what changed, review verdicts, and the branch `team/<slug>`.
8. AskUserQuestion: **Push and open PR** / **Keep local**. Push and `gh pr create` only on an explicit yes (same commands as `/devteam:feature` step 5).

## Reporting
Report only from the Workflow result and `devteam run status`. Never describe results, counts or merges before the Workflow tool has returned. While it runs there is nothing to report yet.
