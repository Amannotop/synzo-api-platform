#!/usr/bin/env bash
# End-to-end smoke test (§53). Exercises the real customer journey against a
# running API: register, login, project, key, models, chat (non-stream +
# stream), usage, and the failure/security paths.
#
# Usage: scripts/smoke.sh [base_url]
set -uo pipefail

BASE="${1:-http://127.0.0.1:3000}"

# The model the suite exercises. Overridable so the same script can be pointed
# at a deployment serving a different catalogue.
SMOKE_MODEL="${SMOKE_MODEL:-${DEFAULT_MODEL:-max}}"

# Resolve the workspace from the script's own location, never the caller's CWD.
# `psql` and the key-hash helper below both read .env, and reading it relative
# to wherever the user happened to be standing made the script fail in a way
# that looked like a missing database rather than a missing file.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
PASS=0
FAIL=0
SMOKE_PID=""
BODY_FILE="$WORK/body.json"
STATUS_FILE="$WORK/status.txt"
touch "$BODY_FILE" "$STATUS_FILE"

# The API started in step 0 is a child of this shell. Without releasing it the
# output pipe stays open after the summary prints, so a caller that reads the
# pipe (`... | tail`) blocks forever on a run that has already finished.
release_server() {
  [ -n "$SMOKE_PID" ] || return 0
  kill "$SMOKE_PID" 2>/dev/null || true
  SMOKE_PID=""
}
trap release_server EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Builds a chat-completions JSON body.
#
# These payloads were single-quoted shell strings holding the model name.
# Single quotes suppress expansion, so the model has to be interpolated with
# printf's %s instead of being pasted in as a literal.
chat_body() {
  printf '{"model":"%s","messages":[{"role":"user","content":"%s"}]%s}' \
    "$SMOKE_MODEL" "${1:-say hi}" "${2:-}"
}

# check <name> <expected_status> <actual_status> [detail]
check() {
  if [ "$2" = "$3" ]; then ok "$1 (status $3)"; else bad "$1 (expected $2, got $3) ${4:-}"; fi
}

# req <method> <url> [body]
# Writes the response body to $BODY_FILE and the status to $STATUS_FILE. Using
# files rather than stdout keeps the status in this shell, since $(...) would
# run the function in a subshell and discard any variable it set.
req() {
  local method="$1" url="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -b "$JAR" -c "$JAR" -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$url" \
      -H 'Content-Type: application/json' -d "$body" > "$STATUS_FILE"
  else
    curl -sS -b "$JAR" -c "$JAR" -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$url" > "$STATUS_FILE"
  fi
}
status() { cat "$STATUS_FILE"; }
body()   { cat "$BODY_FILE"; }

# env_value <NAME> - read one value from the workspace .env, honouring quotes.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  python3 -c "
import re,sys,pathlib
name=sys.argv[1]
m=re.search(rf'^{name}=(.*)$', pathlib.Path(sys.argv[2]).read_text(), re.M)
if not m: sys.exit(0)
v=m.group(1).strip()
if len(v)>=2 and v[0]==v[-1] and v[0] in '\'\"': v=v[1:-1]
print(v)" "$1" "$ENV_FILE" 2>/dev/null
}

jget() { python3 -c "import sys,json;d=json.load(sys.stdin);
import functools
def dig(o,p):
  for k in p.split('.'):
    if k.isdigit() and isinstance(o,list): o=o[int(k)]
    else: o=o.get(k) if isinstance(o,dict) else None
    if o is None: return ''
  return o
print(dig(d,'$1') if dig(d,'$1') is not None else '')" 2>/dev/null; }

# Restart the API against the real upstream before the live checks.
#
# A stale process is the most common cause of a confusing smoke failure: the
# suite would otherwise test whatever code and configuration happened to be
# listening, not the build in this workspace. The health poll below is what
# makes the restart verifiable rather than a hopeful sleep.
if [ "${SMOKE_NO_RESTART:-0}" != "1" ]; then
  step "0. Restart the API"
  if [ -f "$ROOT_DIR/package.json" ] && command -v pnpm >/dev/null 2>&1; then
    # Read .env into the environment for the child process, without `source`ing
    # it into this shell: a .env is data, not a script, and sourcing it would
    # execute anything that happens to be on those lines.
    while IFS= read -r _line; do
      case "$_line" in ''|'#'*|*'='*) ;; *) continue ;; esac
      _key="${_line%%=*}"; _val="${_line#*=}"
      _key="$(printf '%s' "$_key" | tr -d '[:space:]')"
      case "$_key" in ''|[!A-Za-z_]*) continue ;; esac
      # Strip one layer of matching quotes and trailing whitespace.
      _val="${_val%"${_val##*[![:space:]]}"}"
      case "$_val" in \"*\") _val="${_val#\"}"; _val="${_val%\"}" ;; \'*\') _val="${_val#\'}"; _val="${_val%\'}" ;; esac
      export "$_key=$_val"
    done < "$ENV_FILE"

    # `start` runs dist/server.js, so the build has to be current or the smoke
    # would test stale code. Rebuilding is cheap next to a failed run.
    if [ "${SMOKE_NO_BUILD:-0}" != "1" ]; then
      # The workspace packages are built first. `start` executes compiled
      # JavaScript and Node resolves @synzo/* through each package's `exports`
      # to dist/; building only the API leaves a stale packages/*/dist and the
      # start below dies with ERR_MODULE_NOT_FOUND.
      if pnpm run build:packages > "$WORK/build.log" 2>&1 &&
         pnpm --filter @synzo/api run build >> "$WORK/build.log" 2>&1; then
        ok "API build is current"
      else
        bad "API build failed"; sed -n '1,20p' "$WORK/build.log"
      fi
    fi

    # Only touch a port this workspace owns, so a smoke run against a shared
    # or remote instance never kills someone else's process.
    SMOKE_PORT="${BASE##*:}"; SMOKE_PORT="${SMOKE_PORT%%/*}"
    SMOKE_HOST="${BASE#*://}"; SMOKE_HOST="${SMOKE_HOST%%:*}"
    if [ "$SMOKE_HOST" = "127.0.0.1" ] || [ "$SMOKE_HOST" = "localhost" ]; then
      EXISTING=$(lsof -ti "tcp:$SMOKE_PORT" 2>/dev/null || true)
      [ -n "$EXISTING" ] && kill $EXISTING 2>/dev/null && ok "stopped existing process on $SMOKE_PORT"
      ( cd "$ROOT_DIR" && nohup pnpm --filter @synzo/api run start > "$WORK/api.log" 2>&1 & echo $! > "$WORK/api.pid" )
      SMOKE_PID="$(cat "$WORK/api.pid" 2>/dev/null || true)"
      # /health is the liveness probe; it deliberately touches no dependency,
      # so a poll succeeding means the process is actually serving requests.
      HEALTHY=0
      for _ in $(seq 1 60); do
        if curl -sSf -o /dev/null "$BASE/health" 2>/dev/null; then HEALTHY=1; break; fi
        sleep 1
      done
      if [ "$HEALTHY" = "1" ]; then
        ok "API is healthy on $BASE"
      else
        bad "API did not become healthy at $BASE/health"
        sed -n '1,20p' "$WORK/api.log" | sed 's/^/    | /'
        printf '  \033[31mFAIL\033[0m stopping: log kept at %s\n' "$WORK/api.log"
        printf '\n\033[1m================ %d passed, %d failed ================\033[0m\n' "$PASS" "$((FAIL+1))"
        release_server
        exit 1
      fi
    else
      ok "not restarting: $BASE is not local"
    fi
  else
    printf '  \033[33mSKIP\033[0m restart (pnpm unavailable)\n'
  fi
fi

EMAIL="smoke+$(date +%s)@synzo.dev"
# Generated per run so no realistic password is stored in the repository.
# Registration requires >= 10 characters, so the entropy is plenty.
PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-22)"

step "1. Register customer"
req POST "$BASE/api/auth/register" \
  "{\"email\":\"$EMAIL\",\"name\":\"Smoke Customer\",\"password\":\"$PASSWORD\"}"
BODY=$(body)
check "register" 201 "$(status)" "$BODY"
USER_ID=$(printf '%s' "$BODY" | jget user.id)
IS_ADMIN=$(printf '%s' "$BODY" | jget user.role)
[ -n "$USER_ID" ] && ok "returned user id: $USER_ID" || bad "no user id"
printf '  info role=%s (admin only for first user)\n' "$IS_ADMIN"

step "2. Duplicate registration rejected"
req POST "$BASE/api/auth/register" \
  "{\"email\":\"$EMAIL\",\"name\":\"Dup\",\"password\":\"$PASSWORD\"}"
BODY=$(body)
check "duplicate email" 409 "$(status)" "$BODY"

step "3. Session established (register auto-logs-in)"
req GET "$BASE/api/me"
BODY=$(body)
check "GET /api/me" 200 "$(status)" "$BODY"
ME_EMAIL=$(printf '%s' "$BODY" | jget user.email)
[ "$ME_EMAIL" = "$EMAIL" ] && ok "session matches registered email" || bad "session email mismatch: $ME_EMAIL"

step "4. Logout then login"
req POST "$BASE/api/auth/logout" '{}' >/dev/null
req GET "$BASE/api/me"
BODY=$(body)
check "me after logout is 401" 401 "$(status)" "$BODY"
req POST "$BASE/api/auth/login" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
BODY=$(body)
check "login" 200 "$(status)" "$BODY"
req GET "$BASE/api/me"
BODY=$(body)
check "me after login" 200 "$(status)" "$BODY"

step "5. Wrong password rejected"
req POST "$BASE/api/auth/login" "{\"email\":\"$EMAIL\",\"password\":\"WrongPassword123\"}"
BODY=$(body)
check "bad password" 401 "$(status)" "$BODY"

step "6. Create project"
req POST "$BASE/api/projects" '{"name":"Smoke Project"}'
BODY=$(body)
check "create project" 201 "$(status)" "$BODY"
PROJECT_ID=$(printf '%s' "$BODY" | jget project.id)
[ -n "$PROJECT_ID" ] && ok "project id: $PROJECT_ID" || bad "no project id"

step "7. Create test API key (secret shown once)"
req POST "$BASE/api/keys" \
  "{\"name\":\"Smoke Key\",\"projectId\":\"$PROJECT_ID\",\"environment\":\"test\"}"
BODY=$(body)
check "create key" 201 "$(status)" "$BODY"
API_KEY=$(printf '%s' "$BODY" | jget secret)
KEY_ID=$(printf '%s' "$BODY" | jget key.id)
KEY_PREFIX0=$(printf '%s' "$BODY" | jget key.keyPrefix)
[ -n "$API_KEY" ] && ok "secret returned once: ${API_KEY:0:12}…" || bad "no secret returned"
case "$API_KEY" in sk_test_*) ok "secret uses sk_test_ prefix";; *) bad "wrong prefix: $API_KEY";; esac

step "8. Secret is never returned again"
req GET "$BASE/api/keys"
BODY=$(body)
check "list keys" 200 "$(status)" "$BODY"
case "$BODY" in *"$API_KEY"*) bad "secret leaked in key list";; *) ok "no secret in key list";; esac
KEY_PREFIX=$(printf '%s' "$BODY" | jget keys.0.keyPrefix)
[ -n "$KEY_PREFIX" ] && ok "key prefix shown: $KEY_PREFIX" || bad "no key prefix"

step "9. /v1/models with API key"
req GET "$BASE/v1/models"
BODY=$(body)
check "models without key is 401" 401 "$(status)" "$BODY"
OUT=$(curl -sS -w $'\n%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer $API_KEY")
ST="${OUT##*$'\n'}"; BODY="${OUT%$'\n'*}"
check "models with key" 200 "$ST" "$BODY"
# The listing is ordered by public name, so data.0 is alphabetical rather than
# the tier the suite exercises. Assert the model is PRESENT instead of first.
case "$BODY" in
  *"\"id\":\"$SMOKE_MODEL\""*) ok "model listed: $SMOKE_MODEL" ;;
  *) bad "model not in /v1/models: $SMOKE_MODEL" ;;
esac

step "10. Real upstream chat completion (non-streaming)"
OUT=$(curl -sS -w $'\n%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(chat_body)")
ST="${OUT##*$'\n'}"; BODY="${OUT%$'\n'*}"
check "chat completion" 200 "$ST" "$BODY"
CONTENT=$(printf '%s' "$BODY" | jget choices.0.message.content)
printf '  info upstream content: %s\n' "$CONTENT"
[ -n "$CONTENT" ] && ok "received real upstream content" || bad "empty content"
TOTAL=$(printf '%s' "$BODY" | jget usage.total_tokens)
[ -n "$TOTAL" ] && ok "usage.total_tokens reported: $TOTAL" || bad "no usage in response"

step "11. Streaming (real upstream, ends with [DONE])"
OUT=$(curl -sS -N -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(chat_body 'Count 1 to 5, digits only.' ',"stream":true')")
FRAME_COUNT=$(printf '%s' "$OUT" | grep -c '^data: ')
LAST=$(printf '%s' "$OUT" | grep '^data: ' | tail -1)
printf '  info frames: %s, last: %s\n' "$FRAME_COUNT" "$LAST"
[ "$LAST" = "data: [DONE]" ] && ok "stream terminates with [DONE]" || bad "stream did not end with [DONE]"
case "$OUT" in *'"cost"'*) bad "upstream cost frame leaked to client";; *) ok "cost frame suppressed from customer";; esac

step "12. Usage recorded from real traffic"
req GET "$BASE/api/usage?range=today"
BODY=$(body)
check "usage" 200 "$(status)" "$BODY"
REQ_COUNT=$(printf '%s' "$BODY" | jget stats.totalRequests)
TOKENS=$(printf '%s' "$BODY" | jget stats.totalTokens)
printf '  info requests=%s tokens=%s\n' "$REQ_COUNT" "$TOKENS"
[ "${REQ_COUNT:-0}" -ge 2 ] && ok "usage recorded ($REQ_COUNT requests)" || bad "usage not recorded: $REQ_COUNT"

step "13. Request log"
req GET "$BASE/api/requests?limit=5"
BODY=$(body)
check "requests" 200 "$(status)" "$BODY"
R1=$(printf '%s' "$BODY" | jget requests.0.requestId)
R1TOK=$(printf '%s' "$BODY" | jget requests.0.totalTokens)
printf '  info latest request id=%s tokens=%s\n' "$R1" "$R1TOK"
[ -n "$R1" ] && ok "request logged: $R1" || bad "no request logged"
case "$BODY" in *"$API_KEY"*) bad "secret leaked in request log";; *) ok "no secret in request log";; esac

step "14. Security: invalid / malformed / oversized / injection"
req GET "$BASE/v1/models"
BODY=$(body)
check "no auth header" 401 "$(status)" "$BODY"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer sk_test_totally_wrong_key_000")
check "wrong key" 401 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Basic abc123")
check "non-bearer scheme" 401 "$OUT" "$OUT"
OUT=$(curl -sS -w $'\n%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"no-such-model-xyz","messages":[{"role":"user","content":"hi"}]}')
ST="${OUT##*$'\n'}"; BODY="${OUT%$'\n'*}"
check "invalid model" 404 "$ST" "$BODY"
case "$BODY" in *invalid_model*) ok "normalized to invalid_model";; *) bad "wrong error code: $BODY";; esac
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(printf '{"model":"%s","messages":' "$SMOKE_MODEL")")
check "malformed JSON" 400 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(printf '{"model":"%s","messages":[{"role":"admin","content":"x"}]}' "$SMOKE_MODEL")")
check "invalid role rejected" 400 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(printf '{"model":"%s","messages":[]}' "$SMOKE_MODEL")")
check "empty messages rejected" 400 "$OUT" "$OUT"
python3 -c "import json,sys;print(json.dumps({'model':sys.argv[1],'messages':[{'role':'user','content':'x'*2000000}]}))" "$SMOKE_MODEL" > "$WORK/big.json"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data-binary "@$WORK/big.json")
check "oversized body" 413 "$OUT" "$OUT"
# Built with python so the quote in the payload cannot break out of the JSON
# string: a hand-quoted shell payload sends malformed JSON and gets a 400 for
# the wrong reason, which would hide a real injection regression.
python3 -c "import json,sys;print(json.dumps({'model':sys.argv[1],'messages':[{'role':'user','content':'hi'}]}))" \
  "$SMOKE_MODEL' OR 1=1--" > "$WORK/inject.json"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data-binary "@$WORK/inject.json")
check "SQL injection in model" 404 "$OUT" "$OUT"

step "15. Tenant isolation (second customer cannot see first)"
req POST "$BASE/api/auth/logout" '{}'
BODY=$(body)
EMAIL2="smoke2+$(date +%s)@synzo.dev"
req POST "$BASE/api/auth/register" \
  "{\"email\":\"$EMAIL2\",\"name\":\"Second Customer\",\"password\":\"$PASSWORD\"}"
BODY=$(body)
check "second customer registers" 201 "$(status)" "$BODY"
req GET "$BASE/api/projects"
BODY=$(body)
COUNT=$(printf '%s' "$BODY" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('projects',[])))" 2>/dev/null || echo 0)
[ "$COUNT" = "0" ] && ok "second customer sees 0 projects" || bad "second customer sees $COUNT projects"
req GET "$BASE/api/keys"
BODY=$(body)
COUNT=$(printf '%s' "$BODY" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('keys',[])))" 2>/dev/null || echo 0)
[ "$COUNT" = "0" ] && ok "second customer sees 0 keys" || bad "second customer sees $COUNT keys"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/projects/$PROJECT_ID" -b "$JAR")
check "cross-tenant project read" 404 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/keys/$KEY_ID" -b "$JAR" -X DELETE)
check "cross-tenant key delete" 404 "$OUT" "$OUT"
req GET "$BASE/api/usage?range=today"
BODY=$(body)
R2REQ=$(printf '%s' "$BODY" | jget stats.totalRequests)
[ "${R2REQ:-0}" = "0" ] && ok "second customer usage is zero (isolated)" || bad "second customer sees $R2REQ requests"

step "16. Key revoke blocks the key"
req POST "$BASE/api/auth/login" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
req POST "$BASE/api/keys/$KEY_ID/revoke" '{}'
BODY=$(body)
check "revoke key" 200 "$(status)" "$BODY"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer $API_KEY")
check "revoked key rejected" 401 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(chat_body 'hi')")
check "revoked key rejected on chat" 401 "$OUT" "$OUT"

step "17. Expired API key is rejected"
req POST "$BASE/api/projects" '{"name":"Expiry Project"}' >/dev/null
EXP_PROJECT=$(printf '%s' "$(body)" | jget project.id)
req POST "$BASE/api/keys" \
  "{\"name\":\"Expiring\",\"projectId\":\"$EXP_PROJECT\",\"environment\":\"test\"}"
EXPIRED_KEY=$(printf '%s' "$(body)" | jget secret)
# Force expiry directly in the database: a 1-day key cannot be waited out in a
# test, and this asserts the auth middleware honours the stored expires_at.
PSQL_URL=$(env_value DATABASE_URL)
if [ -n "$PSQL_URL" ] && command -v psql >/dev/null 2>&1 && [ -n "$EXPIRED_KEY" ]; then
  HASH=$(printf '%s' "$EXPIRED_KEY" | python3 -c "import sys,hmac,hashlib
pepper=sys.argv[1]
print(hmac.new(pepper.encode(),sys.stdin.read().strip().encode(),hashlib.sha256).hexdigest())" "$(env_value API_KEY_PEPPER)")
  psql "$PSQL_URL" -q -c \
    "UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE key_hash = '$HASH'" >/dev/null 2>&1
  OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer $EXPIRED_KEY")
  check "expired key rejected" 401 "$OUT" "$OUT"
else
  printf '  \033[33mSKIP\033[0m expired key (no DATABASE_URL/psql available)\n'
fi

step "18. Concurrency limit is enforced (deterministic: limit set to 1)"
# Firing N requests and hoping at least one 429s is timing-dependent: if the
# upstream answers faster than the requests are dispatched, every one of them
# is legitimately within the limit and the test fails for the wrong reason.
# Instead the limit is pinned to 1 for the duration of the check, so the second
# request is guaranteed to be shed, and the original value is restored after.
req POST "$BASE/api/keys" \
  "{\"name\":\"Concurrency\",\"projectId\":\"$PROJECT_ID\",\"environment\":\"test\"}"
CONC_KEY=$(printf '%s' "$(body)" | jget secret)

ORIG_CONC=""
if [ -n "$PSQL_URL" ] && command -v psql >/dev/null 2>&1; then
  ORIG_CONC=$(psql "$PSQL_URL" -tAq -c \
    "SELECT max_concurrent_requests FROM customer_limits WHERE user_id = '$USER_ID'" 2>/dev/null | tr -d ' ')
  psql "$PSQL_URL" -q -c \
    "UPDATE customer_limits SET max_concurrent_requests = 1 WHERE user_id = '$USER_ID'" >/dev/null 2>&1
  printf '  info max_concurrent_requests %s -> 1 for this check\n' "${ORIG_CONC:-?}"
fi

# Two requests at once. The first takes the only slot; the second must be shed.
for i in 1 2; do
  ( curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
      -H "Authorization: Bearer $CONC_KEY" -H 'Content-Type: application/json' \
      -d "$(chat_body)" \
      > "$WORK/conc.$i" ) &
done
wait
C1=$(cat "$WORK/conc.1" 2>/dev/null); C2=$(cat "$WORK/conc.2" 2>/dev/null)
printf '  info concurrent status codes: %s %s\n' "$C1" "$C2"
if [ "$C1" = "429" ] || [ "$C2" = "429" ]; then
  ok "second concurrent request is shed with 429"
else
  bad "concurrency limit did not engage (got $C1 and $C2, expected one 429)"
fi

# Restore so later steps and the deployment are left as they were found.
if [ -n "$ORIG_CONC" ] && [ -n "$PSQL_URL" ]; then
  psql "$PSQL_URL" -q -c \
    "UPDATE customer_limits SET max_concurrent_requests = $ORIG_CONC WHERE user_id = '$USER_ID'" >/dev/null 2>&1
  ok "restored max_concurrent_requests to $ORIG_CONC"
fi

step "18b. A genuine upstream failure is normalized and leaks nothing"
# To exercise the real provider-error path against the LIVE OpenCode upstream,
# we register a temporary model whose public name is one the upstream itself
# rejects. The platform admits the request (the model is enabled in its
# registry) and then the real upstream call fails. That is a true provider
# failure, not edge validation, and it must come back normalized and safe.
BAD_PUBLIC="smoke-upstream-reject-$(date +%s)"
BAD_UPSTREAM="smoke-definitely-unsupported-zzz"
if [ -n "$PSQL_URL" ] && command -v psql >/dev/null 2>&1; then
  PROVIDER_ID=$(psql "$PSQL_URL" -tAq -c "SELECT id FROM providers WHERE name='opencode' LIMIT 1" 2>/dev/null | tr -d ' ')
  if [ -n "$PROVIDER_ID" ]; then
    psql "$PSQL_URL" -q -c \
      "INSERT INTO models (public_name, provider_id, upstream_model, enabled) VALUES ('$BAD_PUBLIC', '$PROVIDER_ID', '$BAD_UPSTREAM', true)" >/dev/null 2>&1
    OUT=$(curl -sS -w $'\n%{http_code}' -X POST "$BASE/v1/chat/completions" \
      -H "Authorization: Bearer $CONC_KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$BAD_PUBLIC\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
    ST="${OUT##*$'\n'}"; BODY="${OUT%$'\n'*}"
    printf '  info live upstream rejection -> %s\n' "$ST"
    case "$ST" in
      404) ok "upstream ModelError normalized to 404";;
      502) ok "upstream failure normalized to 502";;
      *)   bad "unexpected status for live upstream failure: $ST";;
    esac
    case "$BODY" in
      *node_modules*|*"at Object"*|*postgres://*|*"ModelError is not supported"*) bad "provider internals leaked: $BODY";;
      *) ok "no provider internals in error body";;
    esac
    # Clean up the throwaway model so the registry is left as found.
    psql "$PSQL_URL" -q -c "DELETE FROM models WHERE public_name = '$BAD_PUBLIC'" >/dev/null 2>&1
    ok "removed temporary failing model"
  else
    printf '  \033[33mSKIP\033[0m live upstream failure (opencode provider row not found)\n'
  fi
else
  printf '  \033[33mSKIP\033[0m live upstream failure (no DATABASE_URL/psql)\n'
fi

step "18c. Stream ends cleanly even when the client stops reading"
# The server must not leave an upstream socket streaming into a client that has
# gone away. curl is told to stop after the first frame; the request still has
# to terminate rather than hang. `head` exiting early can send the pipeline a
# SIGPIPE (exit 141), which is a normal short-read, not a hang — so 141 is
# treated as success and only a real timeout is a failure.
#
# `timeout` is GNU coreutils and does not exist on macOS, which made this step
# exit 127 and silently "pass" the hang check while receiving nothing at all.
# Curl's own --max-time is portable and enforces the same bound.
set -o pipefail
OUT=$(curl -sS -N --max-time 30 -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $CONC_KEY" -H 'Content-Type: application/json' \
  -d "$(chat_body 'Count 1 to 20.' ',"stream":true')" \
  2>/dev/null | head -c 2000)
RC=$?
set +o pipefail
# 124 is GNU timeout's code; curl's own timeout is 28. A SIGPIPE short read
# (141) means the stream was cut cleanly, which is exactly what is asserted.
if [ $RC -eq 124 ] || [ $RC -eq 28 ]; then
  bad "stream hung after the client stopped reading"
elif [ $RC -eq 127 ]; then
  bad "required tool missing (exit 127) - this step did not actually run"
else
  ok "stream terminated after client disconnect (no hang, rc=$RC)"
fi
case "$OUT" in *"data: "*) ok "client received stream frames before disconnect";; *) bad "no frames received";; esac

step "19. Disabled key is rejected, re-enable restores it"
req POST "$BASE/api/keys" \
  "{\"name\":\"Toggle\",\"projectId\":\"$PROJECT_ID\",\"environment\":\"test\"}"
TOGGLE_KEY=$(printf '%s' "$(body)" | jget secret)
TOGGLE_ID=$(printf '%s' "$(body)" | jget key.id)
req POST "$BASE/api/keys/$TOGGLE_ID/status" '{"status":"disabled"}'
check "disable key" 200 "$(status)" "$(body)"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer $TOGGLE_KEY")
check "disabled key rejected" 401 "$OUT" "$OUT"
req POST "$BASE/api/keys/$TOGGLE_ID/status" '{"status":"active"}'
OUT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer $TOGGLE_KEY")
check "re-enabled key works" 200 "$OUT" "$OUT"
# A revoked key must not be re-enabled (§5).
req POST "$BASE/api/keys/$TOGGLE_ID/revoke" '{}'
req POST "$BASE/api/keys/$TOGGLE_ID/status" '{"status":"active"}'
check "revoked key cannot be re-enabled" 409 "$(status)" "$(body)"

step "20. Error responses leak nothing"
req GET "$BASE/api/does-not-exist"
BODY=$(body)
check "unknown route 404" 404 "$(status)" "$BODY"
case "$BODY" in *node_modules*|*postgres://*|*SELECT*|*"at Object"*) bad "error leaked internals: $BODY";; *) ok "no internals in error body";; esac

printf '\n\033[1m================ %d passed, %d failed ================\033[0m\n' "$PASS" "$FAIL"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
