# devteam: a multi-agent software team for Claude Code

devteam turns one Claude Code session into a small software team: an orchestrator, a product analyst, an architect, backend, frontend, data and devops engineers, QA, a security engineer (devsecops), a code reviewer, a debugger, a technical writer and an integrator. It also uses Antigravity (Gemini) for repo maps, a review from a different model family, and overflow work when Claude is rate-limited.

It is built around four problems that multi-agent setups usually hit, and handles each with code rather than more agents:

| Problem | What devteam does |
|---|---|
| **Rate limits** (Claude Pro) | Explicit model and effort per role, concurrency caps, context packs (brief + repo map) instead of cold exploration, lazy review lenses, Gemini offload, proportional paths (quick / bugfix / feature), resumable runs |
| **Coordination tax** | No manager agents. A deterministic workflow does dispatch, ordering, waves, fix-loop caps and the merge queue. Agents get one brief in and return one schema-validated report |
| **Merge conflicts / contract drift** | Contracts are frozen first and types are generated from them. Per-task file ownership is enforced by a hook *and* the gate. A scheduler only parallelizes tasks with disjoint files. Each task gets its own worktree. Hot files and the lockfile belong to the integrator. Merges are serial and gated, with lockfile regeneration |
| **Hard debugging** | Every run has a directory with spec, design, plan, ledger, per-task state, reports, reviews and gate results stamped with a HEAD sha. Commit trailers (`Run:`, `Task:`, `Role:`, `Engine:`). Replayable briefs |

```
You ──► orchestrator (claude --agent devteam:orchestrator, or /devteam:* in any session)
         │ CHECKPOINT 1: spec ............................ product-analyst
         ▼
   workflow devteam:design ── architect (contracts first, design.md, plan.json → `devteam plan check` → waves)
         │                  └─ security threat model ∥ Gemini design review
         │ CHECKPOINT 2: design + contracts + waves
         ▼
   workflow devteam:build
         ├─ prep: integrator installs planned deps
         ├─ wave N: [engineer per task, own worktree] → gate (stop hook) → review lenses → fix loop ≤ 2 → debugger
         │          integrator: serial merges in DAG order, gate after each, rollback on red
         └─ final: system QA ∥ opus whole-branch review ∥ security scanners ∥ Gemini cross-review
         │ CHECKPOINT 3: PR (push + gh pr create only on your yes; you merge)
```

## Install

Prerequisites: Node 20+ (22 recommended), git, and for the TypeScript stack pnpm and Docker (OrbStack or Docker Desktop). Optional, but used by the security gate: `brew install gitleaks osv-scanner semgrep`. Optional, for Gemini: the Antigravity CLI (`agy`) logged in.

```sh
claude plugin marketplace add ~/dev-team
claude plugin install devteam@devteam
# optional: the CLI in your own terminal (Claude sessions get it on PATH automatically)
export PATH="$HOME/dev-team/plugins/devteam/bin:$PATH"
```

The plugin is read in place from `~/dev-team/plugins/devteam`. Edits apply to new sessions. Its hooks are no-ops outside devteam projects and devteam agents.

Open each project once in an interactive `claude` session and accept the workspace trust dialog. Until then Claude Code ignores the project's `.claude/settings.json` permission allowlist, and headless (`claude -p`) runs fall back to your permission mode.

## Use

In a git repository:

```text
/devteam:init                         # config, AGENTS.md (+ CLAUDE.md/GEMINI.md links), sandbox, CI, repo map
claude --agent devteam:orchestrator   # a dedicated team session (or use the skills from any session)
/devteam:feature  <request>           # full flow with 3 checkpoints
/devteam:quick    <small change>      # one task, one role
/devteam:bugfix   <bug report>        # failing test first, then the fix
/devteam:review   <branch | PR | audit>
/devteam:status   /devteam:replay   /devteam:contract-change   /devteam:new-role
```

## Roles

`devteam config` prints the live table. Defaults live in `roles.json`; projects override them in `.team/config.json`.

| team | role | engine / tier | writes |
|---|---|---|---|
| plan | orchestrator | opus/high (main thread) | `.team/**` |
| plan | product-analyst | sonnet/high | `spec.md` |
| plan | architect | opus/high | `packages/contracts/**`, `docs/adr/**`, `plan.json` |
| plan | ux-designer *(off)* | sonnet/medium | `docs/ux/**` |
| build | backend-engineer | sonnet/medium | `apps/api/**`, `packages/db/**` |
| build | frontend-engineer | sonnet/medium | `apps/web/**`, `packages/ui/**` |
| build | data-engineer | sonnet/medium (+ migration review lens) | `data/**`, `pipelines/**`, seeds |
| build | devops-engineer | sonnet/medium (+ infra review lens) | `infra/**`, `docker/**`, CI, compose, Dockerfiles |
| build | integrator | sonnet/medium | root `package.json`, lockfile, workspace config |
| verify | qa-engineer | sonnet/medium | `tests/**`, `*.e2e.ts` |
| verify | code-reviewer | sonnet/high, final: opus/high | read-only |
| verify | security-engineer | sonnet/high | read-only + scanners |
| verify | debugger | sonnet/high | test files |
| verify | tech-writer | Gemini (haiku fallback) | docs, README, CHANGELOG |
| bridge | gemini-bridge | haiku/low | runs `devteam-agy` |

Optional templates (`devteam new-role --list-templates`): mobile-engineer, ml-engineer, performance-engineer, accessibility-auditor, dba, sre.

## Configuration (`.team/config.json`)

| key | meaning |
|---|---|
| `base_branch` | the branch humans merge into; agents never commit or merge there |
| `parallel.claude` / `parallel.gemini` | max concurrent agents per engine (2/2 suits Claude Pro) |
| `fix_loop_max` | review→fix rounds before the debugger diagnoses and the task escalates |
| `gates.contracts / fast / full / security` | shell commands run by `devteam gate --level …` (fast = contracts + fast) |
| `worktree_setup` | runs in fresh task worktrees, e.g. `pnpm install --frozen-lockfile --prefer-offline` |
| `regenerable` / `regenerate_cmd` | lockfiles the merge queue regenerates instead of hand-merging |
| `hot_files` | integrator-owned files that tasks may not list |
| `security_tags` | risk tags that route the security review lens |
| `gemini.enabled / review_tasks / *_model` | Gemini on/off; review `all` / `risky` / `none` tasks; model ids from `agy models` |
| `roles.<name>` | per-role overrides (`enabled`, `owns`, `model`, `effort`, `engine`, `review_when`), or a new `"local": true` role |

Make your linters and formatters ignore `.devteam/` and `.team/` (biome: `vcs.useIgnoreFile: true`; eslint: ignore patterns).

### Sandbox model
`/devteam:init` turns on Claude Code's Bash sandbox with `autoAllowBashIfSandboxed`, so agents' ad-hoc commands (`pnpm test`, `grep`…) run without prompts but cannot write outside their worktree, the run ledger (`.team/`) and the pnpm store.
- `devteam *` is in `excludedCommands`. Task worktrees keep their git metadata in the main checkout's `.git`, and the sandbox always protects `.git`, even with `allowWrite`. So the trusted, fixed `devteam task start / commit / merge` commands run outside the sandbox, and raw `git commit` inside the sandbox fails by design. Use `devteam --cwd <dir> …` instead of `cd <dir> && devteam …`, because a compound command leaves the sandbox only if every part matches an exclusion.
- `gitleaks`, `osv-scanner` and `semgrep` are excluded too, because inside the sandbox they cannot validate TLS to their vulnerability databases.
- `agy`/`devteam-agy` are excluded and use Antigravity's own `--sandbox` plus path-scoped grants.

### Where Gemini works
`devteam-agy run` (overflow tasks) does not edit inside `.claude/worktrees/`. It creates a sibling worktree under `~/.cache/devteam/worktrees/<repo>/` from the same commit, because agy did not reliably persist writes under the repo's ignored `.claude/` directory. The branch it commits to is what the integrator merges, and `devteam run collect --prune` removes the worktree afterwards. Maps and reviews run in agy's `accept-edits` mode, because `plan` mode denies every shell command. With no `write_file` grant they stay read-only. A Gemini task that commits no file changes is reported `failed`, never `done`.

Known agy limitation: its terminal sandbox rejects glob grants, so Gemini often cannot run `pnpm` itself ("globs not supported in readonly path"). The wrapper runs the gate for it and feeds failures back for one retry.

## Adding a role

```sh
devteam new-role mobile-engineer --template mobile-engineer             # from a template, project scope
devteam new-role perf-reviewer --kind reviewer --review-tags perf        # a new review lens
devteam new-role ml-engineer --kind implementer --owns "ml/**" --scope plugin
```

This writes the agent file (fixed sections: identity, ownership, start with `devteam task start`, gate, report, escalation), registers it, and lints it. Workflows read roles from config, so the architect can assign tasks to the new role right away. Changing a role's engine is one line: `"roles": {"tech-writer": {"engine": "claude"}}`.

## Debugging runbook

Everything about a run lives in `.team/runs/<id>/` in the main checkout:

```
run.json  spec.md  design.md  plan.json (tasks + waves)  ledger.md  pr.md
tasks/<id>/state.json        status, attempts, head, branch, worktree, gate result
tasks/<id>/report.json       the engineer's structured report (captured by the stop hook)
tasks/<id>/review-<role>-<n>.json   each review lens, each round
tasks/<id>/wt-gates*.json    gate results copied from the worktree (devteam run collect)
tasks/<id>/agy-*.log/diff    Gemini prompts' inputs and logs
tasks/_epic/                 final reviews, QA
```

| symptom | where to look / what to do |
|---|---|
| "what happened?" | `devteam run status`, then `ledger.md` (every start/stop/gate block/merge/ruling, timestamped) |
| who wrote this line? | `git log --grep "Task: T3"` or `git blame` + the commit trailers |
| task stuck "stop blocked" | `tasks/<id>/state.json` → `gates`; `<worktree>/.devteam/gates.json` has the failing command's tail |
| ownership denial | the hook message lists allowed files; fix `plan.json` (`files`) and `devteam plan check`, or split the task |
| merge conflict | `state.json` → `merge.files`; `/devteam:replay <id>` with **fresh** to redo it on the new epic HEAD |
| a hook misbehaves | `.team/hook-errors.log` (hooks fail open and log here) |
| Gemini says unavailable | `devteam-agy self-test`; work falls back to Claude automatically and the ledger records it |
| reproduce an agent's task | `devteam task brief <run> <id>` is the complete input; `/devteam:replay <id>` re-runs it |

### Recovering after a usage limit or a crash
1. `devteam run status` shows what merged. Merged tasks are skipped on the next `devteam run args … build`.
2. Re-run the build. Tasks resume from their last commit (`state.json` → `head`). Use `devteam task reset` for a fresh start.
3. Or resume the same workflow run with the Workflow tool's `resumeFromRunId`.
4. Near the limit? Add `--overflow` so `low_risk` tasks go to Gemini.

## Develop

```sh
plugins/devteam/tests/run.sh          # 40 tests in temp git repos: scheduler, gate, merge, init, new-role,
                                      # hooks driven by REAL Claude Code payloads (tests/fixtures/hooks, transcripts),
                                      # devteam-agy against a fake agy (tests/fixtures/fake-agy.mjs)
plugins/devteam/tests/capture-hook-fixtures.sh   # re-capture real hook payloads after a Claude Code upgrade
plugins/devteam/bin/devteam lint      # registry ↔ agents ↔ skills ↔ workflows consistency
claude plugin validate plugins/devteam
```

Layout: `agents/` (role prompts), `workflows/` (`design`, `build`, `review`), `skills/` (`/devteam:*`), `hooks/hooks.json` → `bin/devteam hook …`, `lib/` (all deterministic logic), `bin/devteam-agy` (Antigravity adapter), `templates/` (project files, schemas, role templates, protocols).

## Limits and trade-offs

- A medium feature costs roughly 15–25 agent runs (most on Sonnet). On Claude Pro, plan one feature per usage window, or use `--overflow`.
- Workflows cannot ask questions mid-run, so the three checkpoints sit between workflows.
- Ownership is enforced on the Edit/Write tools and on the branch diff. Bash writes are only caught at the gate.
- Gemini runs through `agy` print mode with path-scoped grants. Its edits bypass the Claude edit hook, so the wrapper reverts out-of-ownership files before committing and the gate re-checks.
- CI stays deterministic: no LLM calls and no API keys in GitHub Actions.
