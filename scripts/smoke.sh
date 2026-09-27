#!/usr/bin/env bash
# End-to-end smoke test (§53). Exercises the real customer journey against a
# running API: register, login, project, key, models, chat (non-stream +
# stream), usage, and the failure/security paths.
#
# Usage: scripts/smoke.sh [base_url]
set -uo pipefail

BASE="${1:-http://127.0.0.1:3000}"
WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
PASS=0
FAIL=0
BODY_FILE="$WORK/body.json"
STATUS_FILE="$WORK/status.txt"
touch "$BODY_FILE" "$STATUS_FILE"

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

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

jget() { python3 -c "import sys,json;d=json.load(sys.stdin);
import functools
def dig(o,p):
  for k in p.split('.'):
    if k.isdigit() and isinstance(o,list): o=o[int(k)]
    else: o=o.get(k) if isinstance(o,dict) else None
    if o is None: return ''
  return o
print(dig(d,'$1') if dig(d,'$1') is not None else '')" 2>/dev/null; }

EMAIL="smoke+$(date +%s)@synzo.dev"
PASSWORD="CorrectHorseBattery9"

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
MODEL_ID=$(printf '%s' "$BODY" | jget data.0.id)
[ "$MODEL_ID" = "space-bunny-free" ] && ok "model listed: $MODEL_ID" || bad "unexpected model: $MODEL_ID"

step "10. Real upstream chat completion (non-streaming)"
OUT=$(curl -sS -w $'\n%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"say hi"}]}')
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
  -d '{"model":"space-bunny-free","stream":true,"messages":[{"role":"user","content":"Count 1 to 5, digits only."}]}')
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
  -d '{"model":"space-bunny-free","messages":')
check "malformed JSON" 400 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"space-bunny-free","messages":[{"role":"admin","content":"x"}]}')
check "invalid role rejected" 400 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"space-bunny-free","messages":[]}')
check "empty messages rejected" 400 "$OUT" "$OUT"
python3 -c "import json;print(json.dumps({'model':'space-bunny-free','messages':[{'role':'user','content':'x'*2000000}]}))" > "$WORK/big.json"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data-binary "@$WORK/big.json")
check "oversized body" 413 "$OUT" "$OUT"
OUT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"space-bunny-free' OR 1=1--\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
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
  -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"hi"}]}')
check "revoked key rejected on chat" 401 "$OUT" "$OUT"

step "17. Error responses leak nothing"
req GET "$BASE/api/does-not-exist"
BODY=$(body)
check "unknown route 404" 404 "$(status)" "$BODY"
case "$BODY" in *node_modules*|*postgres://*|*SELECT*|*"at Object"*) bad "error leaked internals: $BODY";; *) ok "no internals in error body";; esac

printf '\n\033[1m================ %d passed, %d failed ================\033[0m\n' "$PASS" "$FAIL"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
