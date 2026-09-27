#!/usr/bin/env bash
#
# Day-to-day operations for this deployment: start, stop, inspect and back up.
#
# The deployment model is one Mac running Postgres, Redis, the API and ngrok,
# with ngrok as the only public ingress. A terminal someone closed is not an
# acceptable reason for the API to stop, so the long-running processes are
# launchd agents with KeepAlive rather than backgrounded shells. This script
# is the supported way to manage them, and it prints the customer-facing URL
# because that is the one piece of information nobody can guess.
#
# Usage:
#   scripts/ops.sh install   # generate + load the launch agents
#   scripts/ops.sh start     # start (or restart) everything
#   scripts/ops.sh stop      # stop everything
#   scripts/ops.sh status    # what is running, and the public URL
#   scripts/ops.sh logs      # tail the logs
#   scripts/ops.sh backup    # take a backup now
#   scripts/ops.sh generate  # write the plists without loading them

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib-ops.sh"

# The API port. 8000 belongs to another process on this machine and must never
# be bound or forwarded by anything here.
API_PORT="${SYNZO_API_PORT:-3000}"
# Kept for local development against the Vite dev server. With
# SERVE_DASHBOARD=true this is not part of the public path at all.
DASHBOARD_PORT="${SYNZO_DASHBOARD_PORT:-5173}"
NGROK_API_PORT=4040

AGENT_PREFIX="ai.synzo"
LOG_DIR="${REPO_ROOT}/logs"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"

API_LABEL="${AGENT_PREFIX}.api"
DASHBOARD_LABEL="${AGENT_PREFIX}.dashboard"
NGROK_LABEL="${AGENT_PREFIX}.ngrok"
BACKUP_LABEL="${AGENT_PREFIX}.backup"

SERVICE_LABELS=("$API_LABEL" "$DASHBOARD_LABEL" "$NGROK_LABEL")

# --- plist generation -----------------------------------------------------

# Escapes a path for XML. The repository path can contain a space -- this one
# does -- and an unescaped ampersand in a plist makes launchd refuse to load
# the job with a parse error that says nothing useful.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# A plist that runs one command and keeps it alive.
#
# KeepAlive (rather than a RestartSec-only setup) is what makes this crash
# resilient: if the process exits for any reason -- a crash, a bad deploy, an
# OOM kill -- launchd starts it again without waiting to be asked. RunAtLoad
# covers the login case, and there is deliberately no StartInterval, because a
# start-interval job is a scheduled job and would fight KeepAlive for control
# of the same process.
write_service_plist() {
  local label="$1" program="$2" args="$3" workdir="$4" out="$5" err="$6"
  cat > "${LAUNCH_AGENTS}/${label}.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${program}</string>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "$workdir")</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${out}</string>
    <key>StandardErrorPath</key>
    <string>${err}</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST
}

# Indents each argument onto its own line, which is what ProgramArguments
# needs. Done with a loop rather than a substitution so an argument
# containing a space or a quote stays a single element.
plist_args() {
  local a
  for a in "$@"; do
    printf '        <string>%s</string>\n' "$(xml_escape "$a")"
  done
}

# Resolves a binary that launchd will also be able to find.
#
# launchd does not inherit this shell's PATH: it gets a minimal one, and a
# binary that only exists because of a tool-specific PATH entry -- a version
# manager, a CI shim, an editor's bundled runtime -- is invisible to it. The
# job then fails to start with an unhelpful "program not found" minutes later,
# from a plist that looks perfectly correct. So the well-known install
# locations are checked directly and the result is baked into the plist.
resolve_binary() {
  local name="$1" candidate
  if [ -n "${2:-}" ] && [ -x "$2" ]; then
    printf '%s' "$2"
    return 0
  fi
  candidate="$(command -v "$name" 2>/dev/null || true)"
  # Accept a path only if it is outside the ephemeral tool runtimes, which are
  # the ones that disappear between sessions.
  case "$candidate" in
    /opt/homebrew/bin/*|/usr/local/bin/*|"${HOME}"/*|"$node_bin"|"")
      [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
      ;;
  esac
  for candidate in "/opt/homebrew/bin/${name}" "/usr/local/bin/${name}"; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  die "${name} is required but was not found in a location launchd can reach. Install it (brew install ${name}) and retry."
}

install_plists() {
  local node_bin ngrok_bin
  node_bin="$(resolve_binary node)"
  ngrok_bin="$(resolve_binary ngrok)"

  mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"
  # Logs can contain request paths and upstream error text. Not world
  # readable, for the same reason the backups are not.
  chmod 700 "$LOG_DIR" 2>/dev/null || true

  # --- API ---------------------------------------------------------------
  # Starts the built server directly rather than through pnpm, so launchd is
  # not supervising a package manager that is supervising node: when the
  # server exits, the thing that restarts is the server, not a wrapper that
  # may decide to exit successfully and stop the restart chain.
  #
  # The config lives in .env and the server reads it with dotenv, so nothing
  # secret is written into the plist.
  write_service_plist \
    "$API_LABEL" \
    "$node_bin" \
    "$(plist_args "${REPO_ROOT}/apps/api/dist/server.js")" \
    "$REPO_ROOT" \
    "${LOG_DIR}/api.out.log" \
    "${LOG_DIR}/api.err.log"

  # --- Dashboard preview ---------------------------------------------------
  # Serves the already-built dashboard with a small static file server, run by
  # node directly.
  #
  # It is not a pnpm/vite invocation because launchd cannot see a pnpm that
  # only exists on an interactive shell's PATH, and because a package manager
  # in the middle of a supervised service adds a way for the process to exit
  # successfully and stop being restarted. The build is a release step
  # (`ops.sh install` performs it); this only serves the result.
  #
  # Only useful when the API is NOT serving the dashboard (SERVE_DASHBOARD
  # false), for working on the frontend against a live API. Harmless
  # otherwise, and it never holds a public port -- ngrok points at the API.
  write_service_plist \
    "$DASHBOARD_LABEL" \
    "$node_bin" \
    "$(plist_args "${OPS_SCRIPT_DIR}/serve-dashboard.mjs" "${REPO_ROOT}/apps/dashboard/dist" "${DASHBOARD_PORT}")" \
    "${REPO_ROOT}" \
    "${LOG_DIR}/dashboard.out.log" \
    "${LOG_DIR}/dashboard.err.log" \
    "Synzo dashboard preview"

  # --- ngrok ---------------------------------------------------------------
  # No token here. ngrok reads its own credentials from its config file, and
  # a token in a plist would be a credential sitting in a file that gets
  # copied around and backed up.
  write_service_plist \
    "$NGROK_LABEL" \
    "$ngrok_bin" \
    "$(plist_args start "--all" "--log" "stdout")" \
    "$HOME" \
    "${LOG_DIR}/ngrok.out.log" \
    "${LOG_DIR}/ngrok.err.log"

  # --- Nightly backup --------------------------------------------------------
  # A scheduled job, not a service, so StartCalendarInterval is right here:
  # it should run at 3am and exit, and the opposite of that would be keeping
  # a process alive to do a once-a-day task.
  cat > "${LAUNCH_AGENTS}/${BACKUP_LABEL}.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${BACKUP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${REPO_ROOT}/scripts/backup.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "$REPO_ROOT")</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>17</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/backup.out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/backup.err.log</string>
</dict>
</plist>
PLIST

  # The preview serves a build that has to exist. Checked here so the failure
  # names the missing thing instead of showing up as an agent that starts and
  # immediately 404s everything.
  if [ ! -f "${REPO_ROOT}/apps/dashboard/dist/index.html" ]; then
    warn "No dashboard build at apps/dashboard/dist -- run \`pnpm build\` before using the preview agent."
  fi

  log "Wrote agents to ${LAUNCH_AGENTS}"
}

# --- launchd control ------------------------------------------------------

# bootout before bootstrap, and ignore the failure.
#
# bootstrap fails with "service already loaded" on a second run, which would
# make `install` fail on every invocation after the first. The ignore is safe
# because the next line loads the file that was just written either way.
load_agent() {
  local label="$1"
  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENTS}/${label}.plist" 2>&1 || return 1
}

unload_agent() {
  launchctl bootout "gui/$(id -u)/$1" >/dev/null 2>&1 || true
}

agent_pid() {
  launchctl list 2>/dev/null | awk -v l="$1" '$3 == l { print $1 }'
}

agent_running() {
  local pid
  pid="$(agent_pid "$1")"
  [ -n "$pid" ] && [ "$pid" != "-" ]
}

# --- public URL ------------------------------------------------------------

# The ngrok URL, read from ngrok's own local API.
#
# This is asked of the running process rather than read from a config file or
# a constant because that is the only source that is true. The ngrok domain is
# account-assigned and so survives a restart, but "should be the same" and "is
# the same" are different claims, and the customer-facing address is exactly
# the thing worth being certain about. No token is read or printed here.
public_url() {
  curl -s --max-time 3 "http://127.0.0.1:${NGROK_API_PORT}/api/tunnels" 2>/dev/null |
    python3 -c '
import json, sys
try:
    tunnels = json.load(sys.stdin).get("tunnels", [])
except Exception:
    sys.exit(0)
# Prefer the tunnel forwarding the API, so if a second tunnel exists the
# printed URL is the one customers are meant to use.
for want in ("%s", "http://localhost:%s"):
    for t in tunnels:
        if t.get("config", {}).get("addr") == want:
            print(t.get("public_url", ""))
            sys.exit(0)
for t in tunnels:
    if t.get("public_url"):
        print(t["public_url"])
        sys.exit(0)
' "$API_PORT" "$API_PORT" 2>/dev/null
}

# --- subcommands ------------------------------------------------------------

cmd_install() {
  install_plists
  # The API serves the built dashboard, so a missing build is a blank page for
  # every customer. Built here rather than assumed, because the alternative
  # is discovering it through the tunnel.
  if [ "$(env_value SERVE_DASHBOARD)" = "true" ]; then
    log "Building the dashboard (SERVE_DASHBOARD=true)"
    (cd "$REPO_ROOT" && pnpm run build >/dev/null 2>&1) ||
      die "The build failed. Fix that before starting the API."
  fi
  for label in "${SERVICE_LABELS[@]}" "$BACKUP_LABEL"; do
    if load_agent "$label"; then
      log "  loaded ${label}"
    else
      warn "could not load ${label}"
    fi
  done
  log ""
  cmd_status
}

cmd_start() {
  for label in "${SERVICE_LABELS[@]}"; do
    if load_agent "$label"; then
      log "  started ${label}"
    else
      warn "could not start ${label}"
    fi
  done
  # A launchd job is "loaded" before its process has bound its port, so wait
  # for the API to actually answer before reporting. A fixed sleep is wrong
  # here: a cold start after a rebuild re-reads config and opens the database,
  # and that can take longer than any single sleep covers. Reporting a URL
  # that is not serving yet is how a status command trains people to ignore
  # it, and a caller that reads the URL and immediately calls it gets a
  # connection-refused page through the tunnel instead of a JSON error.
  if wait_for_api; then
    log ""
    cmd_status
  else
    # Say the service is down and stop, instead of printing a public URL that
    # is not currently serving. The URL is the thing people copy and share, so
    # it must never be printed for an API that is not answering.
    warn "the API did not become healthy on :${API_PORT}"
    warn "check it with: scripts/ops.sh logs api"
    return 1
  fi
}

# Blocks until /health answers on the API port, or the timeout expires.
#
# Returns non-zero on timeout so `start` can say so plainly rather than
# printing a public URL for a service that never came up.
wait_for_api() {
  local attempts=60 i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    # Only wait while launchd still considers the job alive. If the process
    # has already exited, further polling cannot succeed and the caller needs
    # to hear about it now rather than after a full minute.
    agent_running ai.synzo.api || return 1
    sleep 1
  done
  return 1
}

cmd_stop() {
  for label in "${SERVICE_LABELS[@]}"; do
    unload_agent "$label"
    log "  stopped ${label}"
  done
  # The backup job is left installed: stopping the API for an hour should not
  # silently end nightly backups.
  log "  nightly backup left scheduled (${BACKUP_LABEL})"
}

cmd_status() {
  log "Synzo status"
  log ""

  local label
  for label in "${SERVICE_LABELS[@]}"; do
    if agent_running "$label"; then
      printf '  %-24s running (pid %s)\n' "${label#ai.synzo.}" "$(agent_pid "$label")"
    else
      printf '  %-24s stopped\n' "${label#ai.synzo.}"
    fi
  done
  # `grep -c` rather than `grep -q`.
  #
  # `grep -q` exits the instant it finds a match, which closes the pipe while
  # `launchctl list` is still writing. launchctl dies of SIGPIPE, and under
  # `set -o pipefail` that non-zero status is the pipeline's status -- so a
  # scheduled backup reports as "not scheduled". `grep -c` reads all the input
  # and exits on its own, so the only non-zero status is a real grep failure.
  local backup_rows
  backup_rows="$(launchctl list 2>/dev/null | grep -c "${BACKUP_LABEL}" || true)"
  if [ "${backup_rows:-0}" -gt 0 ]; then
    printf '  %-24s scheduled (nightly 03:17)\n' "backup"
  else
    printf '  %-24s not scheduled\n' "backup"
  fi

  log ""
  if curl -s --max-time 3 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    log "  API        responding on :${API_PORT}"
  else
    log "  API        not responding on :${API_PORT}"
  fi

  local url
  url="$(public_url)"
  log ""
  if [ -n "$url" ]; then
    log "  Public URL ${url}"
    log "             (this is the address to give a customer)"
  else
    log "  Public URL unavailable - is ngrok running? (scripts/ops.sh logs)"
  fi

  local newest
  newest="$(latest_backup)"
  log ""
  if [ -n "$newest" ]; then
    log "  Backup     $(basename "$newest")"
  else
    log "  Backup     none yet - run scripts/ops.sh backup"
  fi
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  local file
  for file in api api.err dashboard dashboard.err ngrok ngrok.err backup backup.err; do
    [ -f "${LOG_DIR}/${file}.log" ] || continue
    log "===== ${file}.log ====="
    tail -n "${1:-40}" "${LOG_DIR}/${file}.log"
    log ""
  done
}

cmd_backup() {
  "${OPS_SCRIPT_DIR}/backup.sh"
}

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-status}"
  shift || true
  case "$cmd" in
    install) cmd_install "$@" ;;
    # Writes the plists without loading them. Useful for inspecting or
    # committing the generated agents, and for checking them before they are
    # handed to launchd.
    generate) install_plists ;;
    start)   cmd_start "$@" ;;
    stop)    cmd_stop "$@" ;;
    restart) cmd_stop; cmd_start ;;
    status)  cmd_status "$@" ;;
    logs)    cmd_logs "$@" ;;
    backup)  cmd_backup "$@" ;;
    -h|--help|help) usage ;;
    *) usage; die "Unknown command: ${cmd}" ;;
  esac
}

# Only run when executed, not when sourced. Sourcing this file is how the
# helpers are unit-checked; running main unconditionally on source would fire a
# subcommand at whoever sourced it.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
