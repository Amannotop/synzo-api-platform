#!/usr/bin/env bash
#
# Proves a backup can actually be restored, rather than assuming it.
#
# The check is a real restore into a scratch database followed by a row-count
# comparison against the live one. Every weaker check has the same blind spot:
# a dump can be a valid gzip, pass pg_restore --list, be the right size and
# still not contain the rows. Only restoring and counting shows the data is
# there.
#
# The live database is never written to. The scratch database is created,
# restored into, measured and dropped.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib-ops.sh"

# Dropped on every exit, including failure and Ctrl-C.
#
# A scratch database left behind is not a small problem: it holds a full copy
# of customer data, it is invisible in the normal workflow, and it quietly
# consumes disk on the same machine as the real one. The trap is what makes
# "the script failed halfway" safe rather than messy.
SCRATCH_DB=""

cleanup() {
  local status=$?
  if [ -n "$SCRATCH_DB" ]; then
    # --if-exists so a database the restore never got to create is not itself
    # an error on the way out.
    dropdb --if-exists --force --maintenance-db="$(database_url)" "$SCRATCH_DB" >/dev/null 2>&1 || \
      warn "Could not drop the scratch database '${SCRATCH_DB}'. Remove it manually."
  fi
  return $status
}
trap cleanup EXIT INT TERM

# Tables whose row counts are compared.
#
# Chosen to span the shapes that matter: a table that grows with traffic
# (requests), the tenant table (users), the credential table (api_keys) and an
# aggregate that must survive a restore intact (usage_daily). Comparing one
# table would pass while the others were empty.
WATCHED_TABLES="users projects api_keys requests usage_daily"

row_count() {
  local db="$1" table="$2"
  psql --no-password --tuples-only --no-align \
    --dbname="$db" \
    --command="SELECT count(*) FROM public.${table}" 2>/dev/null
}

main() {
  require_tool pg_restore
  require_tool psql
  require_tool createdb
  require_tool dropdb
  require_tool gzip
  require_local_database

  local target scratch_dir decompressed
  target="${1:-$(latest_backup)}"
  [ -n "$target" ] || die "No backups found in ${BACKUP_DIR}. Run scripts/backup.sh first."
  [ -f "$target" ] || die "No such backup: ${target}"

  log "Verifying $(basename "$target")"

  # --- Integrity ----------------------------------------------------------
  # Checked before anything is created, so a corrupt file costs nothing.
  if ! gzip -t "$target" 2>/dev/null; then
    die "FAIL: not a valid gzip file. The dump is truncated or corrupt."
  fi

  scratch_dir="$(mktemp -d)"
  decompressed="${scratch_dir}/dump"
  if ! gzip -dc "$target" > "$decompressed" 2>/dev/null; then
    rm -rf "$scratch_dir"
    die "FAIL: the gzip stream could not be decompressed."
  fi
  if ! pg_restore --list "$decompressed" >/dev/null 2>&1; then
    rm -rf "$scratch_dir"
    die "FAIL: pg_restore cannot read this as a dump."
  fi
  log "  ok  integrity"

  # --- Restore ------------------------------------------------------------
  local admin_url name
  admin_url="$(database_url)"
  name="$(database_name)"
  # Suffixed rather than timestamped alone: a name that cannot collide with a
  # real database is what keeps this from ever dropping something that matters.
  SCRATCH_DB="${name}_verify_$$"

  log "  ..  restoring into scratch database '${SCRATCH_DB}'"
  if ! createdb --no-password --maintenance-db="$admin_url" "$SCRATCH_DB" 2>/dev/null; then
    rm -rf "$scratch_dir"
    die "FAIL: could not create the scratch database."
  fi

  # --exit-on-error is what turns a partial restore into a failure. Without it
  # pg_restore reports errors and exits 0, and a half-restored database would
  # be compared against the live one and reported as a pass.
  #
  # --no-owner / --no-privileges because the roles in the dump may not exist
  # on this machine, and that difference is irrelevant to whether the rows
  # came back.
  if ! pg_restore --no-password --no-owner --no-privileges --exit-on-error \
        --dbname="${SCRATCH_DB}" "$decompressed" >/dev/null 2>"${scratch_dir}/restore.err"; then
    warn "pg_restore reported:"
    head -20 "${scratch_dir}/restore.err" >&2
    rm -rf "$scratch_dir"
    die "FAIL: the restore did not complete."
  fi
  rm -rf "$scratch_dir"
  log "  ok  restore"

  # --- Compare ------------------------------------------------------------
  local scratch_url table source_count restored_count failures=0
  scratch_url="${admin_url%/*}/${SCRATCH_DB}"

  for table in $WATCHED_TABLES; do
    source_count="$(row_count "$admin_url" "$table" || echo "")"
    restored_count="$(row_count "$scratch_url" "$table" || echo "")"
    if [ -z "$restored_count" ]; then
      # A missing table is a failure, not a zero. Reporting it as 0/0 "match"
      # would make a restore that dropped the schema look identical to a good
      # one, which is the exact false pass this script exists to prevent.
      printf '  FAIL %-14s missing from the restored database\n' "$table" >&2
      failures=$((failures + 1))
      continue
    fi
    if [ "$source_count" != "$restored_count" ]; then
      printf '  FAIL %-14s live=%s restored=%s\n' "$table" "$source_count" "$restored_count" >&2
      failures=$((failures + 1))
    else
      printf '  ok   %-14s %s rows\n' "$table" "$restored_count"
    fi
  done

  if [ "$failures" -gt 0 ]; then
    die "FAIL: ${failures} table(s) did not match. This backup is not trustworthy."
  fi

  log "PASS: the backup restores cleanly and every watched table matches the live database."
}

main "$@"
