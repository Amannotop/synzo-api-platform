# AGENTS.md

Synzo API Platform — multi-customer OpenAI-compatible AI API. pnpm workspace, TypeScript
strict, Fastify 5 API + React/Vite dashboard, Drizzle/Postgres + Redis. Deployed as a **single
Mac** behind ngrok (no Docker, no cloud). `README.md` is the product/ops reference; this file
covers what an agent gets wrong.

## Commands

`pnpm` and `corepack` are **not installed** in this environment. Use the workspace binaries
directly (or `npx <tool>`); `pnpm run <script>` will fail with `command not found`.

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json            # API + packages
./node_modules/.bin/tsc --noEmit -p apps/dashboard/tsconfig.json
./node_modules/.bin/eslint .                                 # or --fix
./node_modules/.bin/vitest run --project unit                # 176 tests, ~2s, no services
./node_modules/.bin/vitest run --project integration         # needs real Postgres + Redis
./node_modules/.bin/vitest run --project unit tests/unit/crypto.test.ts   # single file
./node_modules/.bin/vitest run --project integration tests/integration/credits.test.ts
node scripts/check-start.mjs                                 # prod-start guard; run after build
scripts/smoke.sh [base_url]                                  # real upstream, needs running API
```

`pnpm run verify` = `typecheck && lint && test`, in that order. Integration tests share one
database, so `fileParallelism: false` in `vitest.config.ts` — do not "fix" the slowness by
enabling it.

## Currently failing gates (verified 2026-09-28)

`typecheck` and the API build are now **clean**. `lint` still fails, and the
failures are not project code:

- **`lint`**: 34 errors, *all* in `tmp/ui-audit/*.mjs` — untracked scratch browser
  scripts in the gitignored `tmp/`. `eslint.config.mjs` ignores `.kilo/**` but
  **not** `tmp/`. Delete the scratch dir or add `tmp/**` to the ignore list.

The tree also holds a large **uncommitted credit/billing system** and, on top of
it, the model-access tier work. Commit before switching branches.

## Entitlements: `allowed_models` is tri-state, and NULL is overloaded

`customer_limits.allowed_models` is a JSON array string with three states, all
handled by `parseAllowedModels` (`apps/api/src/lib/allowed-models.ts`):

| stored | meaning |
| --- | --- |
| `NULL` | every model |
| `'[]'` | no model — an intentional lockout, **and** a brand-new account |
| `['low']` | exactly that list |

The trap: a new account's row is written as `'[]'`, not NULL, because NULL
means "has every model" and a NULL default would make `unionAllowedModels` read
an unconfigured account as already-entitled, silently absorbing the tier. See
migration `0008`. An **unrestricted** trial must then actively *write* NULL —
`entryPlan` returns `{allowedModels: null}` — because skipping the write would
leave the customer with zero models, the opposite of unrestricted. Both failure
modes are silent, so verify with a query rather than by reading the code.

Purchases are **additive**: `unionAllowedModels` unions, so buying a cheaper
tier later never narrows access (`applyPlanAccess` in
`apps/api/src/repositories/credit.repository.ts`).

`FREE_TRIAL_PACKAGE` decides what a trial grants: empty = cheapest active
package, a name = that package, `none` = no model restriction.

## Architecture

- `apps/api` — `server.ts` boots; **`app.ts` is the composition root** (wiring only, no logic).
  Routes are registered in order, and `registerStaticRoutes` is **last** on purpose so API routes
  win the match and the SPA fallback never swallows `/api` or `/v1`.
- `apps/dashboard` — React 18 + Vite 6, TanStack Query, Recharts. Routes in `src/App.tsx`.
- `packages/{config,types,validation,database}` — shared, consumed via `@synzo/*`.

**Build order is load-bearing.** `pnpm run build` compiles `packages/*` *before* the API, because
those packages export compiled `dist/` (`NodeNext`, `main`/`exports` → `dist`). If one regresses to
exporting `.ts` source, `node dist/server.js` dies with `ERR_MODULE_NOT_FOUND` — but **no test
catches it**, because Vitest and tsx resolve those specifiers through aliases. `check-start.mjs`
exists solely to catch this regression.

Path aliases are declared in **three places that must stay in sync**: root `tsconfig.json` paths,
`vitest.config.ts` (per project — Vitest ignores a root-level `resolve.alias`), and each package's
own build. New `@synzo/*` package means editing all of them.

**Env loading** happens at import time in `packages/config/src/env.ts`: it reads the repo-root
`.env` and is **skipped entirely when `NODE_ENV=production`**. Booleans are parsed strictly
(`'false'` is not `true`). Editing `.env.example` means also editing the zod schema.

**Migrations are hand-rolled**, not drizzle-kit applied. `packages/database/src/migrate.ts` applies
`packages/database/migrations/*.sql` in filename order, one transaction each, tracked in
`_migrations`. drizzle-kit only *generates* (`--filter @synzo/database generate`). Migrations
`0001`–`0008` exist; add `0009_*.sql` and never edit an applied one.

## Testing quirks

`tests/helpers/harness.ts` reads the **repo-root `.env`**, then forces `NODE_ENV=test`,
`LOG_LEVEL=error`, and points `UPSTREAM_BASE_URL` at a local stub — so nothing reaches the
internet. It defaults `APPROVAL_REQUIRED=false`; pass `createHarness({ creditSystem: true })` to
opt into real approval/credit semantics.

**A third, separate opt-in governs model tiers.** `planEntitlements: true` is what makes a trial
grant only the entry package's models; without it the harness sets `FREE_TRIAL_PACKAGE=none` and
the trial is unrestricted. It is deliberately *not* folded into `creditSystem`: a suite about
credit accounting still addresses models by name (`max`, `high`) and expects them to work, so
turning on model tiers for it would fail every one of those calls with a correct-but-unrelated
404. Expect ~70 failures across the integration suite if you conflate them.

- Integration tests hit the **same live database as your dev instance** and neither migrate nor
  truncate it. Run `pnpm run migrate` after pulling new migrations. They write real rows.
- `MAIL_TRANSPORT=log` means test output contains **working password-reset and verify-email
  links**. Never paste raw integration-test output into a public issue or commit.
- Provider mechanics (timeouts, dropped streams, malformed SSE) are only deterministic against the
  local stub. Never point the suite at live OpenCode; `scripts/smoke.sh` covers the real upstream.

## Env and secrets

`.env` is gitignored, `.env.example` is the committed contract. Traps:

- **`UPSTREAM_API_KEY` must be empty.** OpenCode Zen returns 401 for *any* `Authorization` header,
  including a bogus one, so the platform sends none when unset.
- **`MAIL_TRANSPORT=log` is rejected under `NODE_ENV=production`** — a logged reset link is a
  working credential.
- **`ADMIN_PASSWORD` is dead.** It is parsed into `config.admin.password`
  (`packages/config/src/env.ts:788`) but no code path reads it; admin password always comes from
  the signup/password-change form. `ADMIN_EMAIL` *is* live and matters.
- With `ADMIN_EMAIL` unset, the **first account to register becomes admin**. Set it before exposing
  signup.
- Never put a secret in a plist, a log line, or a customer-facing error body. Upstream failures are
  classified (`upstream_authentication_failed`, …), never echoed.

## Ports and ops

API on **3000**, Vite dev server on **5173**. **Port 8000 belongs to another process on this
machine** — never bind, forward to, or reconfigure it.

**Rebuilding the dashboard requires restarting the API.** `@fastify/static` snapshots the asset
directory at *boot* (`apps/api/src/routes/static.routes.ts:72`). Vite writes new content-hashed
filenames on every build, so a rebuilt bundle is invisible to a running API: the new `.css`/`.js`
404 into the SPA fallback and come back as `text/html`, which the browser refuses as a stylesheet.
Symptom is a **blank dashboard with a MIME-type console error**, not a build failure. The old hash
404s as JSON. Restart the API after every dashboard build.

**`scripts/ops.sh install` and `start` shell out to `pnpm run build`** (`scripts/ops.sh:299`) and
therefore fail outright when pnpm is absent. Worse, `start` stops the agents *before* building, so
a failed build leaves the whole stack **down**. In that environment bootstrap the plists directly —
launchd runs the built server, not pnpm, so this needs no pnpm:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.synzo.api.plist       # + .dashboard, .ngrok
```

`scripts/ops.sh` drives launchd (`install` / `start` / `stop` / `status` / `logs` / `backup` /
`generate`). Backups are written **outside the repo** to
`~/Library/Application Support/Synzo/backups`; `scripts/restore.sh` requires typed confirmation,
refuses a non-local `DATABASE_URL`, and needs the API stopped first.

## Conventions

- `noUncheckedIndexedAccess: true` — array/record access needs a guard; this is the most common
  typecheck error.
- ESLint: type-aware linting is deliberately off. `no-explicit-any` is an error (disabled in
  tests), `no-console` allows only `warn`/`error` (disabled in `scripts/**`, `*.mjs`, and the
  migrate/seed entry points), `consistent-type-imports` requires `import type`.
- Prettier: `singleQuote`, `semi`, `trailingComma: all`, `printWidth: 100`, 2 spaces.
- `import` specifiers inside `src` use the `.js` extension even though the files are `.ts`.
- Commit messages: single imperative line, `Area: what changed and why`
  (e.g. `Rate limiting: atomic multi-scope admission, plus unit and integration coverage`).
- `.kilo/worktrees/` holds a stale untracked copy of the workspace. It is not in git and is
  ESLint-ignored — do not read it as current source.
