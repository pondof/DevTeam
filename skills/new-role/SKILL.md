---
name: new-role
description: "devteam new role: add an agent to the team (for example a mobile engineer, ML engineer, performance or accessibility reviewer, DBA, SRE). Creates the agent file from the role template, registers ownership, engine, model tier and review triggers, and lints the result. Project scope (default) or plugin scope."
allowed-tools:
  - Read
  - Edit
  - AskUserQuestion
  - Bash(devteam *)
---

# devteam: new-role

1. `devteam new-role --list-templates` shows ready-made roles (mobile-engineer, ml-engineer, performance-engineer, accessibility-auditor, dba, sre). If one fits, use `--template <name>`.
2. Otherwise ask the human, in **one** AskUserQuestion with up to 4 questions:
   - **Kind**: `implementer` (owns files and does tasks), `reviewer` (read-only lens, routed by risk tags or file globs), or `support`.
   - **Scope**: this project only (default) or the plugin (every project).
   - **Engine and tier**: Claude sonnet/medium (default), Claude haiku/low (mechanical work), Claude opus/high (rare, for deep judgment), or Gemini (runs on the Google quota through the bridge).
   - For implementers, the **owned paths**. For reviewers, the **trigger** risk tags or globs.
3. Run, for example:
   `devteam new-role mobile-engineer --kind implementer --owns "apps/mobile/**" --model sonnet --effort medium --team build --description "React Native app screens and native modules"`
   `devteam new-role perf-reviewer --kind reviewer --review-tags perf --review-globs "apps/api/src/db/**" --effort high`
4. Open the generated agent file and replace the "Role-specific guidance" placeholder with 5–10 concrete rules for this role in this stack: libraries, pitfalls, what "done" means. Keep the start/gate/report instructions as they are.
5. `devteam lint --project` (or `devteam lint` for plugin scope) must show no errors. Ownership-overlap warnings are fine if they are intended; tasks will then split files explicitly.
6. Tell the human the role is ready: the architect can assign tasks to it from the next design. Plugin-scope roles need a plugin reload (`/plugin`, or restart Claude Code) before the new agent type is available.
