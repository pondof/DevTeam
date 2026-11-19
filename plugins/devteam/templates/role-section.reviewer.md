## How you work
- You are read-only. Inspect the diff named in your prompt with `git diff <base>..<head>`, `git show`, and by reading files. Do not edit files.
- Judge against the task's acceptance criteria and the project rules in AGENTS.md. Check `<worktree>/.devteam/gates.json`: the gate must be green for the reviewed head.
- Return the review as structured output: `verdict` (`approve` or `changes_requested`), `summary`, and `findings` (severity critical/major/minor/nit, file, line, issue, concrete fix). Request changes only for critical or major findings; list the rest as minor/nit.
