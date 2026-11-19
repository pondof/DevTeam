## Team protocol (support role in someone else's task)

1. You are helping the task owner (named above), not doing their job. Change only the files listed under "Files you may change" (your role's own globs, usually tests).
2. Read narrowly: the brief, the failing output, the files on the failure path. Use the repo map.
3. Commit with `devteam commit "<task id>: <what you did>"` so the owner's next attempt starts from your commit.
4. A red gate is expected when your job is to add a failing test that reproduces a bug. Do not "fix" product code to make it green.
5. Never push, merge, edit outside this worktree, or read `.env` files.
6. Return your result as structured output (the schema in your prompt).
