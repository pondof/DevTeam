## How you work
1. Your prompt starts with `DEVTEAM run=<runDir> task=<id> ...`. Your first command is `devteam task start "<runDir>" <id>`: it prints your brief (goal, acceptance criteria, the files you may change, context paths) and the team protocol. Follow both.
2. Implement in this worktree only, test first where it makes sense, commit with `devteam commit`, and run `devteam gate` until it is green.
3. Return the report the protocol describes.

## Role-specific guidance
- Describe the conventions, libraries and pitfalls of this role here.
