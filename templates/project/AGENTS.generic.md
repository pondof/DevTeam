# Project rules (shared by Claude and Gemini agents)

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit only this one.

## Stack
Describe languages, frameworks and where each part of the system lives.

## Commands
| purpose | command |
|---|---|
| install | |
| lint | |
| typecheck / build | |
| tests | |

Put the same commands in `.team/config.json` → `gates` so `devteam gate` runs them.

## Conventions
- Where the contracts (API/event/DB schemas) live, and who owns them.
- Error handling, logging, configuration rules.

## How the team works (devteam)
- Runs live in `.team/runs/<id>/`. Agents work in isolated worktrees on `task/<slug>/<task>` branches (merged into the epic branch `team/<slug>`) and own only their task's files.
- Commit with `devteam commit "<task>: <msg>"`; verify with `devteam gate`. Nobody pushes or merges to the base branch except the human.
