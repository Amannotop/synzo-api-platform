#!/usr/bin/env bash
#
# Shared helpers for the operations scripts.
#
# Sourced, not executed. Everything that more than one script needs to agree
# on -- where the database URL comes from, where backups live, how a
# connection is checked -- lives here so backup.sh, restore.sh and
# verify-backup.sh cannot drift apart and disagree about the target.

set -euo pipefail

# Resolved from this file, so the scripts work no matter where they are called
# from. launchd runs them with the repo as the working directory, but a human
# types them from anywhere.
OPS_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${OPS_SCRIPT_DIR}/.." && pwd)"

# Backups live outside the repository on purpose. A .dump in the working tree
# is one `git clean -fdx` away from gone, and it is a full copy of every
# customer's credentials and request history sitting in a directory that gets
# synced and backed up by other tools.
BACKUP_DIR="${SYNZO_BACKUP_DIR:-${HOME}/Library/Application Support/Synzo/backups}"

# How long a dump is kept. Fourteen days is long enough to notice a bad week
# and still short enough that the directory does not grow without bound.
BACKUP_RETENTION_DAYS="${SYNZO_BACKUP_RETENTION_DAYS:-14}"

# Port 8000 belongs to another process on this machine. The API serves on
# 3000; a mistake here would dump or restore the wrong server's data.
RESERVED_PORT_GUARD=8000

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Reads one key from .env without sourcing the file.
#
# Sourcing would be simpler, but .env is a dotenv file: values are not shell
# (no quoting guarantees, `VAR=value with spaces` is legal there and a syntax
# error here), and sourcing a malformed file executes it. Reading the key we
# need is both safer and immune to the difference.
env_value() {
  local key="$1" file="${REPO_ROOT}/.env" line trimmed value first last
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    # Trim leading whitespace, then skip comments and blanks.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in ''|'#'*) continue ;; esac
    [ "${trimmed%%=*}" = "$key" ] || continue
    value="${trimmed#*=}"
    # Strip one layer of matching surrounding quotes, dotenv-style. The value
    # is assigned to a local and printed exactly once: printing before the
    # strip would emit the unstripped value too, and both would concatenate.
    first="${value:0:1}"
    last="${value: -1}"
    if [ "${#value}" -ge 2 ]; then
      case "${first}${last}" in
        \"\"|'') value="${value:1:${#value}-2}" ;;
      esac
    fi
    printf '%s' "$value"
    return 0
  done < "$file"
  return 0
}

# The connection string, minus any query string, because pg_dump --dbname
# and createdb take a database name rather than a URL with parameters.
database_url() {
  local url
  url="$(env_value DATABASE_URL)"
  [ -n "$url" ] || die "DATABASE_URL is not set in ${REPO_ROOT}/.env"
  printf '%s' "${url%%\?*}"
}

# The database name, needed to create and drop the scratch database that
# verify-backup.sh restores into.
database_name() {
  local url name
  url="$(database_url)"
  name="${url##*/}"
  name="${name%%\?*}"
  [ -n "$name" ] || die "Could not read a database name from DATABASE_URL"
  printf '%s' "$name"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"
}

# Refuses to act on a URL pointing somewhere other than the local machine.
#
# The backup and restore paths are destructive against whatever they are given.
# A DATABASE_URL that has been edited to point at a shared instance should fail
# loudly here rather than drop a database someone else is using.
require_local_database() {
  local url host
  url="$(database_url)"
  host="${url#*://}"; host="${host#*@}"; host="${host%%/*}"; host="${host%%:*}"
  case "$host" in
    localhost|127.0.0.1|::1|'') return 0 ;;
  esac
  die "Refusing to run: DATABASE_URL points at '${host}', not this machine. Backups and restores here are only for the local database."
}

# A stable, filesystem-safe prefix shared by every dump.
backup_prefix() {
  database_name | tr -c 'A-Za-z0-9_-' '_'
}

ensure_backup_dir() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
}

# Newest first, so "the most recent backup" is genuinely the most recent one
# rather than whichever name sorted highest.
list_backups() {
  [ -d "$BACKUP_DIR" ] || return 0
  # shellcheck disable=SC2012
  ls -1t "${BACKUP_DIR}/${1}-"*.dump.gz 2>/dev/null || true
}

latest_backup() {
  list_backups "${1:-$(backup_prefix)}" | head -1
}

