## Team protocol (implementer)

1. **Read narrowly.** This brief, the spec/design sections for your task, the files you will change and their direct neighbours. Use the repo map instead of exploring. Every file you read costs the team's shared rate limit.
2. **Contract first.** Types come from `packages/contracts` (generated). Never hand-write a type that the contract defines, and never change the contract: only the architect does.
3. **Test first where it makes sense.** Write or adjust a failing test for each acceptance criterion you own, then implement until it passes.
4. **Stay in your files.** The ownership hook and the gate reject anything outside "Files you may change". If you truly need another file, a new dependency in a hot file (root `package.json`, workspace config), or a contract change, stop and return status `blocked` or `needs_contract_change` with the exact request in `contract_change_request` / `deps_requested`. Do not work around the guard.
5. **Commit with `devteam commit "<task id>: <what changed>"`.** It adds the Run/Task/Role/Engine trailers that make `git log --grep "Task: <id>"` work. Small commits are fine.
6. **Run `devteam gate`.** It checks a clean tree, your file ownership, then the configured lint/typecheck/test/contract commands, and stamps the result with your HEAD. Fix, commit, re-run until it is green. The stop hook will send you back if the gate is not green for your current HEAD.
7. **Never:** push, merge, rebase onto other branches, edit outside this worktree, read `.env` files, disable tests, or weaken a check to make it pass.
8. **Return your report** as structured output: `status` (`done` only if the gate is green), `summary` (2–4 sentences a reviewer can trust), `branch`, `head_sha`, `worktree`, `files_changed`, `commands_run` (with exit codes), `tests_added`, `deps_requested`, `contract_change_request` (empty string if none), `decisions`, `open_questions`, `risks`.
