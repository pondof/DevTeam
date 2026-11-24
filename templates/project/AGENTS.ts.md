# Project rules (shared by Claude and Gemini agents)

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit only this one.

## Stack
- pnpm workspace monorepo, Node 22, TypeScript strict everywhere.
- `apps/api`: Fastify. `apps/web`: Next.js (App Router) + React.
- `packages/contracts`: **the single source of truth** for the API. `openapi.yaml` (+ `events/*.json`) → generated types in `packages/contracts/gen/` (do not edit `gen/`).
- `packages/db`: schema + timestamped SQL migrations for Postgres. `packages/ui`: shared components.
- Tests: Vitest (unit/integration, next to the code as `*.test.ts`), Playwright (`tests/e2e`, `*.e2e.ts`).
- Local services: `docker compose up -d` (Postgres on 5432).

## Commands
| purpose | command |
|---|---|
| install | `pnpm install` |
| lint | `pnpm -s lint` |
| typecheck | `pnpm -s typecheck` |
| unit tests | `pnpm -s test` |
| contract drift check | `pnpm -s contracts:check` (regenerates types, fails on diff) |
| build | `pnpm -s build` |
| e2e | `pnpm -s test:e2e` (needs `docker compose up -d`) |

## Conventions
- API handlers validate input and output against the contract; the web app uses the generated typed client only, never ad-hoc `fetch` types.
- Frontend work that runs before the API exists uses mocks generated from the contract examples.
- No secrets in code or tests. Config comes from environment variables documented in `.env.example`.
- Migrations are forward-only and timestamped (`YYYYMMDDHHMMSS_name.sql`); every migration is reviewed by the data-engineer lens.
- Errors: API returns RFC 9457 problem+json as declared in the contract.

## How the team works (devteam)
- Work arrives as runs in `.team/runs/<id>/` (spec, design, plan, ledger). Agents work in isolated worktrees on `task/<slug>/<task>` branches (merged into the epic branch `team/<slug>`) and own only the files their task lists.
- Commit with `devteam commit "<task>: <msg>"`; verify with `devteam gate`. Nobody pushes or merges to `main` except the human.
- Role definitions: `devteam config`. Project-specific overrides live in `.team/config.json`.
