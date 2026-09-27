#!/usr/bin/env bash
#
# Restores a backup over the live database.
#
# This is destructive: it drops the target database and rebuilds it from the
# dump, so everything written since that dump was taken is gone. That is why
# it refuses to run without an explicit confirmation, why it refuses to run
# at all against a database that is not on this machine, and why it takes a
# safety dump of the current state first.
#
# Usage:
#   scripts/restore.sh                        # newest backup, asks first
#   scripts/restore.sh <path-to-dump.gz>      # a specific backup, asks first
#   scripts/restore.sh --yes                  # newest backup, no prompt
#   scripts/restore.sh --yes <path>           # specific, no prompt

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib-ops.sh"

# The API holds open connections to this database, and pg_restore cannot
# restore into a database that still has them. Terminating them is what makes
# the restore possible without bouncing the whole process; a live API writing
# to a database mid-restore is the thing this warning is about.
disconnect_clients() {
  local url="$1"
  psql --no-password --dbname="$url" --command="
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND application_name NOT LIKE '%psql%';" >/dev/null 2>&1 || true
}

main() {
  require_tool pg_restore
  require_tool psql
  require_tool dropdb
  require_tool createdb
  require_tool gzip
  require_local_database

  local assume_yes=false target=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) assume_yes=true; shift ;;
      --help|-h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
      -*) die "Unknown option: $1" ;;
      *) target="$1"; shift ;;
    esac
  done

  [ -n "$target" ] || target="$(latest_backup)"
  [ -n "$target" ] || die "No backups found in ${BACKUP_DIR}. Run scripts/backup.sh first."
  [ -f "$target" ] || die "No such backup: ${target}"

  local url name stamp
  url="$(database_url)"
  name="$(database_name)"

  # Refusing early beats restoring and discovering the problem afterwards.
  if ! gzip -t "$target" 2>/dev/null; then
    die "That file is not a valid gzip dump. Refusing to restore from it."
  fi

  # Decompressed once, to a real file, and kept until the restore finishes.
  #
  # The obvious `<(gzip -dc "$target")` is wrong here and fails after the
  # database has already been dropped: pg_restore cannot read a custom-format
  # dump from a process substitution, because the format needs to seek around
  # the file to find its table of contents and a pipe is not seekable. The
  # error it gives is "did not find magic string in file header", which says
  # nothing about the real problem. Verified: the same restore from a real
  # file works.
  local scratch_dir decompressed
  scratch_dir="$(mktemp -d)"
  decompressed="${scratch_dir}/dump"
  if ! gzip -dc "$target" > "$decompressed" 2>/dev/null; then
    rm -rf "$scratch_dir"
    die "The dump could not be decompressed."
  fi
  if ! pg_restore --list "$decompressed" >/dev/null 2>&1; then
    rm -rf "$scratch_dir"
    die "pg_restore cannot read this file as a dump. Refusing to restore from it."
  fi

  # --- Confirmation -------------------------------------------------------
  # Restoring is the one operation here that destroys data a customer cannot
  # get back, so it gets a real prompt with the specifics in it. "Are you
  # sure?" is not enough when the reader has to know which database and which
  # dump, and the default answer is the safe one.
  if [ "$assume_yes" != true ]; then
    log "About to REPLACE the database '${name}' with:"
    log "  dump: ${target}"
    log "  taken: $(basename "$target" | sed -n 's/.*-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump\.gz/\1/p' | sed 's/T/ /; s/Z/ UTC/')"
    log ""
    log "Everything written since that dump will be lost."
    log "The API should be stopped first; a live API will break during the restore."
    log ""
    printf 'Type the database name (%s) to continue: ' "$name"
    local answer
    read -r answer
    if [ "$answer" != "$name" ]; then
      log "Aborted. Nothing was changed."
      return 1
    fi
  fi

  # --- Safety net ---------------------------------------------------------
  # A dump of the current state before the destructive step. If the restore
  # turns out to be the wrong backup, this is the only way back.
  log "Taking a safety dump of the current database first"
  if ! "${OPS_SCRIPT_DIR}/backup.sh" >/dev/null 2>&1; then
    die "Could not take the safety dump, so the restore was not attempted. Fix that first."
  fi
  local safety
  safety="$(latest_backup)"
  log "  safety dump: ${safety}"

  # --- Restore ------------------------------------------------------------
  log "Disconnecting clients from '${name}'"
  disconnect_clients "$url"

  # dropdb --force terminates anything reconnecting. Without it, a launchd
  # KeepAlive that restarts the API within seconds of the drop reconnects and
  # the database is not actually gone, so the restore below fails against a
  # database that still has the old schema.
  log "Dropping and recreating '${name}'"
  dropdb --no-password --if-exists --force "$name" || die "Could not drop '${name}'."
  createdb --no-password "$name" || die "Could not recreate '${name}'."

  # --exit-on-error so a partial restore fails loudly instead of leaving a
  # half-populated database that looks restored.
  log "Restoring"
  local status=0
  pg_restore --no-password --no-owner --no-privileges --exit-on-error \
    --dbname="$name" "$decompressed" || status=$?
  rm -rf "$scratch_dir"

  if [ "$status" -ne 0 ]; then
    die "The restore failed partway. The database is incomplete; the safety dump above can bring back the previous state."
  fi

  log "Restored '${name}' from $(basename "$target")."
  log "Restart the API with: scripts/ops.sh start"
}

main "$@"
