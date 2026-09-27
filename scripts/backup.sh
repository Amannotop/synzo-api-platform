#!/usr/bin/env bash
#
# Takes one timestamped, compressed pg_dump of the local database.
#
# Custom format (-Fc), not SQL text, because custom format is what pg_restore
# needs: it can be restored selectively, it restores far faster, and it is
# compressed by default. A plain-text dump of a growing requests table costs
# more disk and takes longer to come back from than it saves in flexibility.
#
# Safe to run while the API is serving. pg_dump takes a consistent snapshot
# without blocking writers, so this does not need a maintenance window.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib-ops.sh"

main() {
  require_tool pg_dump
  require_tool gzip
  require_local_database

  local url name prefix stamp target tmp
  url="$(database_url)"
  name="$(database_name)"
  prefix="$(backup_prefix)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="${BACKUP_DIR}/${prefix}-${stamp}.dump.gz"
  tmp="${target}.in_progress"

  ensure_backup_dir

  log "Backing up '${name}' to ${target}"

  # Written to a temporary name and renamed only after gzip succeeds.
  #
  # A dump that fails halfway through a scheduled job must not be left looking
  # like a good backup: the retention sweep would keep it for two weeks and a
  # restore would discover the truncation at the worst possible moment. The
  # rename is atomic, so a file bearing the final name is always complete.
  #
  # The pipeline's exit status is checked with PIPESTATUS rather than the
  # pipeline's own, because the last command in a pipe decides what the
  # pipeline returns -- which here is gzip, and gzip happily reports success on
  # an empty input after pg_dump has already died.
  # pipefail is set in lib-ops.sh, which is what makes this test meaningful:
  # it is pg_dump's failure that fails the pipeline, not gzip's.
  if ! pg_dump --dbname="$url" --format=custom --compress=6 --no-password \
        2>"${tmp}.err" | gzip -9 > "$tmp"; then
    warn "pg_dump failed:"
    cat "${tmp}.err" >&2 || true
    rm -f "$tmp" "${tmp}.err"
    die "No backup was written. The previous backups are untouched."
  fi

  if [ -s "${tmp}.err" ]; then
    warn "pg_dump reported:"
    cat "${tmp}.err" >&2
  fi
  rm -f "${tmp}.err"

  # A zero-byte file means the dump produced nothing at all. Left in place it
  # would be listed as the newest backup and restore into an empty database.
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "The dump was empty; refusing to record it as a backup."
  fi

  mv "$tmp" "$target"
  chmod 600 "$target" 2>/dev/null || true

  # Prove this one, not just the next scheduled run. A backup that has never
  # been restored is a hypothesis, and the failure mode is finding out during
  # an incident.
  assert_dump_is_restorable "$target"

  prune_old_backups "$prefix"

  log "Wrote $(du -h "$target" | cut -f1) to ${target}"
  log "Verify it any time with: scripts/verify-backup.sh"
}

# Drops dumps past the retention window.
#
# Only files matching this database's own prefix are considered. The directory
# is shared with any other database backed up from this machine, and a bare
# `find -mtime` would delete those too.
prune_old_backups() {
  local prefix="$1" file name
  local removed=0
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    name="$(basename "$file")"
    if [ -z "$(find "$file" -mtime "+${BACKUP_RETENTION_DAYS}" 2>/dev/null)" ]; then
      continue
    fi
    if rm -f "$file" && [ -n "$removed" -eq 0 ]; then
      log "Pruned ${name} (older than ${BACKUP_RETENTION_DAYS} days)"
      removed=1
    fi
  done < <(list_backups "$prefix")

  if [ "$removed" -eq 0 ]; then
    log "Nothing older than ${BACKUP_RETENTION_DAYS} days to prune"
  fi
}


# Checks that a dump is both intact and actually restorable.
#
# pg_restore cannot open a gzipped file directly: it is given the decompressed
# stream on stdin instead. Both checks matter and they fail differently --
# gzip -t catches a truncated or corrupted file, and pg_restore --list catches
# a file that decompresses cleanly but is not a dump. A file that passes
# gzip -t and fails pg_restore is exactly the shape of a half-written backup
# that a naive "is it a file, is it non-empty" check would wave through.
assert_dump_is_restorable() {
  local file="$1" scratch
  if ! gzip -t "$file" 2>/dev/null; then
    rm -f "$file"
    die "The dump failed its gzip integrity check and was discarded."
  fi

  # Decompressed to a real file rather than piped.
  #
  # pg_restore --list stops reading as soon as it has the table of contents,
  # so on a pipe it exits 141 (SIGPIPE) as the decompressor is still writing.
  # Under pipefail that is indistinguishable from a real failure, and the
  # backup that just succeeded gets deleted for it. Given a path, pg_restore
  # reads only what it needs and exits 0.
  scratch="$(mktemp -d)/dump"
  if ! gzip -dc "$file" > "$scratch" 2>/dev/null; then
    rm -rf "$scratch"
    rm -f "$file"
    die "The dump could not be decompressed and was discarded."
  fi
  if ! pg_restore --list "$scratch" >/dev/null 2>&1; then
    rm -rf "$scratch"
    rm -f "$file"
    die "The dump is not readable by pg_restore and was discarded."
  fi
  rm -rf "$scratch"
}

main "$@"
