# Synzo API Platform

A multi-customer, OpenAI-compatible AI API. Customers create a project, mint an
API key, and call `/v1/chat/completions` with the same request body they would
send to OpenAI. The platform handles accounts, keys, rate limits, per-customer
usage accounting, and the upstream provider call.

This deployment is **one Mac** running Postgres, Redis, the API and ngrok, with
ngrok as the only public ingress. It is hardened for that reality, not for a
data centre.

---

## Contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Running locally](#running-locally)
- [Single-origin serving](#single-origin-serving)
- [ngrok setup](#ngrok-setup)
- [Operations](#operations)
- [Metrics](#metrics)
- [Backups](#backups)
- [Data retention](#data-retention)
- [Credit management](#credit-management)
- [API documentation](#api-documentation)
- [API Playground](#api-playground)
- [Testing](#testing)
- [Production assumptions and limits](#production-assumptions-and-limits)

---

## What it does

| Area | Behaviour |
| --- | --- |
| Accounts | Email + password, hashed with scrypt. Sessions are cookie-based. |
| Projects and keys | Each project holds scoped API keys. Keys are shown once and stored hashed. |
| Chat | `POST /v1/chat/completions`, OpenAI-shaped, streaming and non-streaming. |
| Models | Five effort tiers, all resolving to the free upstream model. |
| Rate limits | Per-minute, per-day, token and concurrency ceilings, enforced in Redis. |
| Usage | Every completion is recorded; `usage_daily` aggregates power the dashboard. |
| Audit | Auth, key and admin actions are logged. |
| Operations | Prometheus metrics, nightly backups, retention sweeps. |

---

## Prerequisites

- **Node 20+** (developed on 26.x)
- **pnpm 11+**
- **PostgreSQL 14+** running locally
- **Redis** (or Valkey) running locally
- **ngrok** with an account — `brew install ngrok`
- macOS, if you want the `launchd` service management

```bash
node --version && pnpm --version
psql -d synzo_api -c 'select 1'      # should succeed
redis-cli ping                        # should print PONG
```

---

## Running locally

```bash
cp .env.example .env
# Fill in the secrets: SESSION_SECRET, API_KEY_PEPPER, ADMIN_PASSWORD.
# Leave UPSTREAM_API_KEY empty — see the note under "Production assumptions".

pnpm install
pnpm run migrate
pnpm run db:seed          # creates the admin account
pnpm run dev              # API on :3000, dashboard on :5173
```

The dashboard is at <http://localhost:5173>. Sign in with the `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from `.env`.

> **Port 8000 belongs to another process on this machine.** Nothing in this
> project binds, forwards to, or configures it. The API is on **3000** and the
> Vite dev server on **5173**.

---

## Single-origin serving

In development the dashboard runs on Vite's own port and Vite proxies `/api` and
`/v1` through to the API. That proxy is a development affordance. In production
it is removed: the API serves the built dashboard itself.

```bash
pnpm run build
SERVE_DASHBOARD=true pnpm start
```

Now one process on one port serves both:

- `/`, `/operations`, `/documentation` → the dashboard SPA
- `/api/*`, `/v1/*` → the API, always JSON
- `/health`, `/ready`, `/version` → JSON, never HTML
- `/docs` → Swagger UI
- `/openapi.json` → the OpenAPI 3.1 document
- `/metrics` → Prometheus text (see below)

Deep links work on a hard refresh, because unmatched paths fall through to
`index.html`. That fallback deliberately excludes `/api` and `/v1`, so a mistyped
API path returns a JSON 404 rather than a page of HTML.

With a single origin, CORS stops being load-bearing for the dashboard, and the
tunnel needs only one forward.

`SERVE_DASHBOARD` defaults to **false** so `pnpm dev` and the test suite are
unaffected. When it is on, startup fails if `apps/dashboard/dist/index.html` is
missing, rather than serving a blank page.

---

## ngrok setup

ngrok is the only public ingress. The API's domain is account-assigned, so it is
stable across restarts.

```bash
ngrok config add-authtoken <your-token>
```

The token is stored in ngrok's own config file. **It never goes in this
repository or in a plist.**

Point the tunnel at the API (3000), not at Vite:

```
# ~/.config/ngrok/ngrok.yml  (or ~/Library/Application Support/ngrok/ngrok.yml)
tunnels:
  synzo:
    proto: http
    addr: 3000
```

Then `scripts/ops.sh status` prints the live public URL, read from ngrok's local
API at `127.0.0.1:4040` rather than assumed from a config file.

> The public hostname is detected from the incoming request, so the same build
> works on any domain. `PUBLIC_BASE_URL` is optional; set it only to pin the
> origin (for example if a proxy's forwarded headers are wrong).

---

## Operations

`scripts/ops.sh` manages the deployment.

```bash
scripts/ops.sh install    # generate + load the launchd agents (also builds)
scripts/ops.sh start      # start or restart everything
scripts/ops.sh stop       # stop the services
scripts/ops.sh status     # what is running, and the public URL
scripts/ops.sh logs       # tail the logs
scripts/ops.sh backup     # take a backup now
scripts/ops.sh generate   # write the plists without loading them
```

`install` writes four `~/Library/LaunchAgents` plists:

| Label | What it runs |
| --- | --- |
| `ai.synzo.api` | `node apps/api/dist/server.js` |
| `ai.synzo.dashboard` | a static server for the built dashboard, on 5173 |
| `ai.synzo.ngrok` | `ngrok start --all` |
| `ai.synzo.backup` | `scripts/backup.sh`, nightly at 03:17 |

The three services use `KeepAlive` and `RunAtLoad`, with no `StartInterval`: if a
process dies, launchd restarts it. A start-interval would fight `KeepAlive` for
control of the same process. The backup is a scheduled job
(`StartCalendarInterval`), because it should run once and exit.

Logs are written to `logs/`, which is gitignored and mode 700 — they can contain
request paths and upstream error text.

Binaries are resolved to stable locations (`/opt/homebrew/bin`) rather than
whatever happens to be on an interactive shell's `PATH`, because launchd does not
inherit that `PATH` and a job pointing at a session-only tool fails minutes
later for no visible reason.

---

## Metrics

`GET /metrics` returns Prometheus text:

- `synzo_http_requests_total` — by method, route, status
- `synzo_http_request_duration_seconds` — latency histogram
- `synzo_chat_requests_total` and `synzo_chat_request_duration_seconds`
- `synzo_upstream_errors_total` — by kind
- `synzo_rate_limit_rejections_total` — by scope
- `synzo_provider_healthy` — per-provider gauge

These are **process-local** and reset on restart. The `requests` table remains
the source of truth for billing and reporting; the registry covers what the
database cannot see.

The endpoint is restricted. A tunnel makes the port public, so "unauthenticated"
cannot mean "readable by anyone on the internet". Three ways in:

1. a genuine loopback caller — a loopback socket address *and* a loopback `Host`
2. a signed-in admin session
3. `Authorization: Bearer <METRICS_TOKEN>`

Both halves of the loopback check matter: ngrok's edge connects from
`127.0.0.1`, so judging locality by peer address alone would make `/metrics`
world-readable the moment a tunnel is open. The `Host` header is the
discriminator, and a remote caller cannot forge it into looking local.

The dashboard's **Operations** page (`/operations`, admin only) reads the same
data as a summary and adds p50/p95/p99 latency and per-model error rates.

```bash
curl http://localhost:3000/metrics
METRICS_ENABLED=false   # serve no /metrics at all
```

---

## Backups

Dumps live outside the repository, in
`~/Library/Application Support/Synzo/backups` — a `.dump` in the working tree is
one `git clean` away from gone, and it is a full copy of customer data in a
directory that other tools sync.

```bash
scripts/ops.sh backup              # or scripts/backup.sh
scripts/verify-backup.sh           # prove the newest one restores
scripts/restore.sh                 # restore, with a confirmation prompt
scripts/restore.sh --yes           # unattended
```

`backup.sh` writes a gzipped custom-format `pg_dump` (seamless while the API is
serving), keeps **14 days**, and writes to a temporary name that is renamed only
after the dump verifies. A half-written file is therefore never recorded as a
backup.

`verify-backup.sh` restores the newest dump into a **scratch database** and
compares row counts against the live one, across `users`, `projects`, `api_keys`,
`requests` and `usage_daily`. A valid gzip that passes `pg_restore --list` can
still be missing rows; only a real restore shows the data is there. The scratch
database is dropped on every exit, including failure.

```bash
$ scripts/verify-backup.sh
Verifying synzo_api-20260927T161200Z.dump.gz
  ok  integrity
  ..  restoring into scratch database 'synzo_api_verify_47945'
  ok  restore
  ok   users          2713 rows
  ok   projects       1891 rows
  ok   api_keys       1207 rows
  ok   requests        837 rows
  ok   usage_daily     716 rows
PASS: the backup restores cleanly and every watched table matches the live database.
```

A corrupt dump is rejected rather than passed:

```
$ scripts/verify-backup.sh corrupt.dump.gz
error: FAIL: not a valid gzip file. The dump is truncated or corrupt.
```

`restore.sh` refuses to run without confirmation (type the database name),
refuses to run against a non-local `DATABASE_URL`, verifies the dump *before*
dropping anything, and takes a safety dump of the current state first. Stop the
API first — a live API will break during a restore.

```bash
scripts/ops.sh stop
scripts/restore.sh
scripts/ops.sh start
```

---

## Data retention

A scheduled sweep keeps the database from growing without bound:

- `requests` older than `REQUEST_RETENTION_DAYS` (default 90), in bounded batches
- expired sessions
- expired or sufficiently old consumed account tokens
- obsolete rate-limit daily counters

`usage_daily` aggregates, audit logs and recent requests are **never** pruned —
usage reporting has to survive the history it was computed from.

```bash
REQUEST_RETENTION_DAYS=90
RETENTION_INTERVAL_MS=86400000
RETENTION_ENABLED=true
```

---

## Credit management

Customers do not get an API key that draws on an unlimited upstream balance.
Every account holds two separate token balances, and every request is charged
against one of them before it is allowed to reach the provider.

### The model

| Piece | Where it lives | Notes |
| --- | --- | --- |
| `users.status` | `pending` / `active` / `suspended` / `rejected` | Approval gate. Enforced on the API path, not just hidden in the UI. |
| `credit_balances` | free + paid, each with granted / used / reserved / remaining | Free and paid never mix, so a paying customer watches the promotion drain before their money. |
| `credit_ledger` | append-only | Every grant, deduction, refund and manual adjustment, with the balance after each. |
| `credit_reservations` | per in-flight request | A worst-case claim held for the life of a request. |
| `payment_requests` | one row per submitted payment | Approved inside a transaction guarded on `status = 'pending'`. |
| `credit_packages` | operator-configured | Name, credits, price, currency, sort order. |
| `billing_settings` | singleton | Payment QR, instructions, method label, currency. |

**Reservation is the interesting part.** A request cannot be charged a number
nobody knows yet — the completion has not been written when the call starts. So
before every request, the platform claims an upper bound atomically inside a
transaction, calls the provider, and then settles at the provider's own reported
count, returning the unused remainder immediately. That is what stops two
concurrent requests each claiming 900 tokens against a 1,000 balance from both
succeeding.

The bound is `CREDIT_MAX_RESERVATION_TOKENS` (default 32,000), deliberately far
below the provider's output cap. Taking the cap literally would mean only two
concurrent unbounded requests fit inside a 500k trial, so ordinary customers
would be told they were out of credits while demonstrably holding half a
million of them.

When a balance is too small for the full bound, the claim is **clamped to what
is actually spendable** rather than refusing the request. A customer holding 500
credits used to be shown "500 remaining" and then refused every call, including
a two-word prompt that genuinely cost under 500; they are now served, charged
the real amount, and never driven below zero. If even a minimal request cannot
be covered, that is a genuine exhaustion and returns a structured 402.

### Migrations

`0004`–`0006` add the credit system. They are additive: existing accounts,
projects, keys and `requests` rows are untouched, and every account starts with
a zero balance.

```bash
pnpm run migrate
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPROVAL_REQUIRED` | `true` | New signups are `pending` until approved. `false` grants the trial at signup instead. |
| `FREE_TRIAL_TOKENS` | `500000` | The one-time trial. `0` disables it. |
| `CREDIT_MAX_RESERVATION_TOKENS` | `32000` | Worst-case claim per request. |
| `CREDIT_RESERVATION_SWEEP_INTERVAL_MS` | `60000` | How often reservations orphaned by a crash are reclaimed. |
| `PAYMENT_MAX_UPLOAD_BYTES` | `5000000` | Cap on receipts and QR images, checked on the decoded bytes. |
| `TELEGRAM_BOT_TOKEN` | — | Optional. Both Telegram values or neither. |
| `TELEGRAM_CHAT_ID` | — | Destination chat. Negative for a group. |
| `TELEGRAM_TIMEOUT_MS` | `5000` | Deliberately short: a notification is a side effect, never a gate. |
| `ADMIN_EMAIL` | — | Address that becomes admin on signup, skipping the queue. |

All are documented in `.env.example`.

### Configuring the payment QR and packages

Both live in **Admin → Credits**, and both are server-side state — nothing
sensitive is in the frontend bundle.

1. **Credits → Payment method.** Upload a PNG, JPEG or WebP QR, or paste an
   `https` URL for one you host. Plain `http` is rejected: a QR fetched over it
   can be swapped in transit and the customer scans the wrong destination. Data
   uploads are decoded and their magic bytes checked before storage, so the
   operator's own browser is never handed an arbitrary payload to render. Add
   the payment method label, the instructions, and the default currency.
2. **Credits → Packages.** Create the tiers you sell. Price and credit amounts
   are read from the server when a payment is submitted — a client cannot name
   its own price.

The billing form sends only the fields you actually edited. Saving a QR upload
does not clear your instructions.

### Configuring Telegram

Optional. Without it, payments are still recorded and the dashboard shows the
notification as not sent, with a manual retry.

1. Message **@BotFather**, send `/newbot`, copy the token.
2. Message your new bot once so it has something to reply to.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `"chat":{"id":...}`. A group id is negative.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`, then restart.

The token is read only by the server-side notifier. It is never in an API
response, the dashboard bundle, or a log line, and a test asserts that. Delivery
failure never loses the payment request and never grants credits.

### The customer-to-admin workflow

1. Customer registers → `status: pending`, **no** trial, API calls refused with
   `invalid_api_key` (indistinguishable from a bad key, so nothing leaks about
   which accounts exist).
2. Admin finds them by name or email under **Credits → Customers** and clicks
   **Approve & grant trial**. The account becomes active and exactly 500,000
   free tokens land in the same transaction. A second click is a replay: the
   response says `alreadyTrialed` and adds nothing.
3. Customer uses the API. Charges settle at the provider's real token count.
4. Balance reaches zero → `402 credit_exhausted` with the remaining balances in
   the body, and the dashboard shows the paywall.
5. Customer picks a package, confirms the email **on their own account** (a
   mismatch is rejected — email alone is not proof of identity), pays by QR, and
   submits the transaction reference and optionally a receipt. Status is
   `pending`; the reference is unique, so a double submit is refused.
6. Admin reviews the payment under **Credits → Payments**, sees the receipt, and
   approves. The exact package credits land in the paid pool and API access
   resumes. Approving again returns `replayed: true` and allocates nothing.
7. Every step is in the ledger, and every admin action is in the audit log.

Customers cannot approve themselves, cannot reach any admin route, and cannot
read another customer's ledger — all enforced server-side and covered by tests.

### Known limits

- Credits are **tokens**, not money. There is no pricing per token, no partial
  refund, and no proration; a package grants a flat credit count.
- Settlement is capped at what a request reserved. If the provider reports more
  than was held, the customer is under-charged by the difference. This is the
  deliberate trade that keeps balances from going negative; the provider's real
  count is always recorded in `requests` for reconciliation.
- `ADMIN_PASSWORD` is **not read by any code path.** Password is always the one
  chosen on the signup or password-change form. It remains in `.env.example` so
  an existing deployment is not surprised by it doing nothing.
- With `ADMIN_EMAIL` unset, the first account to register on a fresh instance
  becomes admin. On a publicly reachable signup form that means whoever
  registers first takes control, so set `ADMIN_EMAIL` before exposing the site.

---

## API documentation

- `/docs` — Swagger UI
- `/openapi.json` — the OpenAPI 3.1 document

The spec is generated from the same code that serves the routes, so it cannot
drift. Its `servers` entry is derived per request, so "Try it out" targets the
hostname the reader actually reached.

Swagger's assets are served from this origin rather than a CDN — documentation
should not depend on a third-party host being reachable. A Content-Security-
Policy is active in single-origin mode with `script-src 'self'` and no
`unsafe-inline`, which is why the Swagger bootstrap is an external file at
`/docs/swagger-initializer.js` rather than an inline `<script>`.

The dashboard's `/documentation` page holds a quickstart; the authoritative
reference is `/docs`.

---

## API Playground

`/playground` in the dashboard is a page for using the API without writing a
client first. It has three parts:

- **Connection** — a base URL and an API key. The base URL defaults to wherever
  the page was served from, and both fields stay editable, so a key issued
  elsewhere or a different deployment can be used without touching code. The
  key is held in memory by default. Ticking "Remember this key on this device"
  keeps it in `localStorage`, which means any script on the origin can read it,
  so the page says so plainly and unticking the box deletes it.
- **Try a request** — sends the message to `/v1/chat/completions` with whatever
  connection details are above and shows the reply plus the raw JSON body.
- **Use the API directly** — cURL, Python, JavaScript and "list models"
  snippets generated from the base URL and key already entered, so they are
  ready to paste rather than a template to edit.

Base-URL handling is deliberate, because it is the easiest thing to get wrong:
a trailing `/v1` is collapsed, so both `https://host` and the SDK's
`https://host/v1` produce the same endpoints instead of `/v1/v1`. A bare host
is upgraded to `https://`, and anything that is not an http(s) URL is rejected
rather than repaired, so a typo cannot send a key to an unexpected scheme.

The cURL snippet shell-quotes its values. A key containing a quote produces a
command that still runs, instead of a shell syntax error that looks like a
rejected key.

Cross-origin requests are subject to the other server's CORS policy. Entering a
base URL on a different origin works from a terminal but may be refused by the
browser, and the page warns when the base URL is cross-origin rather than
letting a CORS failure look like a bad key.

---

## Testing

```bash
pnpm run typecheck
pnpm run lint
pnpm run test          # 412 tests
pnpm run build
SERVE_DASHBOARD=true pnpm run check:start
```

Integration tests run against a real Postgres and Redis, and against a local stub
upstream so nothing reaches the internet. `scripts/smoke.sh` covers the real
OpenCode Zen upstream.

---

## Production assumptions and limits

**All tiers resolve to the same free upstream model.** `max`, `high`, `medium`
and `low` are distinct names with different descriptions and limits, but they
all point at one upstream model. Effort is *not* differentiated. This is
deliberate for now and is the single most important thing to know before
selling it.

**`UPSTREAM_API_KEY` must be empty.** OpenCode Zen returns 401 for *any*
`Authorization` header, including a bogus one, so the platform sends none when
the key is unset. If the upstream rejects the credential, the API now reports it
as an upstream authentication failure rather than a generic 502 — but the honest
fix is a key the provider accepts.

**ngrok's free tier has no uptime guarantee.** The hardening here makes the
application resilient; it cannot make the tunnel reliable. `ops.sh status` and
the Operations page exist to make outages diagnosable rather than invisible.

**A single Mac is a single point of failure.** Postgres, Redis, the API and the
tunnel are all on one machine. Backups are nightly, not continuous, so at most a
day of writes is at risk from any single event.

**No Docker, no cloud managed services.** That is the deployment model this
hardening targets.

---

## Security notes

- Secrets live in `.env`, which is gitignored. Only `.env.example` is committed.
- The ngrok token stays in ngrok's own config file.
- No secret is written into a plist, a log, or a customer-facing error body.
- Upstream error text is never echoed to customers; failures are classified
  (`upstream_authentication_failed`, `upstream_rate_limited`, …) and the body
  says only what is safe to say.
- Log redaction is covered by tests.

---

## Layout

```
apps/api/           Fastify API: auth, chat, admin, metrics, docs, static SPA
apps/dashboard/     React dashboard (TanStack Query, Recharts, React Router)
packages/           config, types, validation, database (Drizzle)
scripts/            ops, backup, restore, verify-backup, smoke, check-start
tests/              unit + integration, against real Postgres and Redis
```
