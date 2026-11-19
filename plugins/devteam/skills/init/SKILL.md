---
name: init
description: "devteam init: set up the current git repository for the devteam multi-agent team. Writes .team/config.json (roles, ownership, gates), AGENTS.md (with CLAUDE.md and GEMINI.md symlinks), sandbox and permission settings, a deterministic CI workflow, and .gitignore entries, then checks Antigravity and builds the first repo map."
allowed-tools:
  - Read
  - Edit
  - AskUserQuestion
  - Bash(devteam *)
  - Bash(devteam-agy *)
  - Bash(git status*)
  - Bash(git init*)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(ls*)
---

# devteam: init

1. This must be a git repository. If it isn't, ask before running `git init`.
2. Detect the stack: `ls` for `pnpm-workspace.yaml`, `package.json`, `apps/`, `packages/`. A TypeScript pnpm monorepo gets `--stack ts`. Anything else gets `--stack generic`, and you then fill in the gate commands.
3. `devteam init --stack <ts|generic>` (add `--no-sandbox` only if the human asks). It never overwrites existing files without `--force`.
4. Open `.team/config.json` and check it against the repo:
   - `gates`: each command must exist in the repo's package.json scripts. Remove the ones that don't exist yet, or tell the human which scripts to add (`lint`, `typecheck`, `test`, `contracts:check`, `build`, `test:e2e`).
   - `roles.<name>.owns`: adjust ownership globs to the real layout, for example `"backend-engineer": {"owns": ["services/api/**"]}`.
   - `base_branch` must match the repo's default branch.
5. `devteam lint --project` must show no errors.
6. `devteam-agy self-test`. If it reports `unavailable`, set `"gemini": {"enabled": false}` in `.team/config.json` and tell the human that Gemini review and overflow are off until `agy` works.
7. `devteam-agy map` (1–3 minutes) writes `.team/context/map.md`.
8. Show the human what was created, and ask whether to commit: `git add .team/config.json AGENTS.md CLAUDE.md GEMINI.md .claude/settings.json .github/workflows/devteam-ci.yml .gitignore docs/adr && git commit -m "chore: set up devteam"`. Worktrees branch from HEAD, so committed config is what the agents see.
9. Next steps for the human: `claude --agent devteam:orchestrator` for a team session, or `/devteam:feature`, `/devteam:quick`, `/devteam:bugfix`, `/devteam:review` in any session.
