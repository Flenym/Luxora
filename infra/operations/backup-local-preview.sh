#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$script_directory/common.sh"

usage() {
  printf '%s\n' \
    'Usage:' \
    '  backup-local-preview.sh --database /absolute/luxora.db \' \
    '    --blobs /absolute/blobs --uploads /absolute/uploads \' \
    '    --destination /absolute/new-backup --confirm-api-stopped' \
    '' \
    'Creates a local/offline preview snapshot. It never stops the API itself.'
}

database_input=""
blobs_input=""
uploads_input=""
destination_input=""
confirmed_stopped="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database) [[ $# -ge 2 ]] || luxora_ops_die '--database requires a value'; database_input="$2"; shift 2 ;;
    --blobs) [[ $# -ge 2 ]] || luxora_ops_die '--blobs requires a value'; blobs_input="$2"; shift 2 ;;
    --uploads) [[ $# -ge 2 ]] || luxora_ops_die '--uploads requires a value'; uploads_input="$2"; shift 2 ;;
    --destination) [[ $# -ge 2 ]] || luxora_ops_die '--destination requires a value'; destination_input="$2"; shift 2 ;;
    --confirm-api-stopped) confirmed_stopped="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) luxora_ops_die "unknown argument: $1" ;;
  esac
done

[[ -n "$database_input" && -n "$blobs_input" && -n "$uploads_input" && -n "$destination_input" ]] || {
  usage >&2
  exit 2
}
[[ "$confirmed_stopped" == "true" ]] || \
  luxora_ops_die 'refusing an unconfirmed snapshot: stop the API, verify it is stopped, then pass --confirm-api-stopped'

luxora_ops_require_command realpath
luxora_ops_require_command sqlite3
luxora_ops_require_command find
luxora_ops_require_command awk

database="$(luxora_ops_canonical_existing "$database_input" 'database')"
blobs="$(luxora_ops_canonical_existing "$blobs_input" 'blobs directory')"
uploads="$(luxora_ops_canonical_existing "$uploads_input" 'uploads directory')"
destination="$(luxora_ops_canonical_new "$destination_input" 'backup destination')"

[[ -f "$database" && ! -L "$database" ]] || luxora_ops_die 'database must be a regular, non-symlink file'
[[ "$database" != *"'"* && "$destination" != *"'"* ]] || \
  luxora_ops_die "database and destination paths cannot contain a single quote in this preview tool"
luxora_ops_assert_distinct_roots "$blobs" "$uploads" 'blobs directory' 'uploads directory'
luxora_ops_is_within "$database" "$blobs" && luxora_ops_die 'database cannot be inside the blobs tree'
luxora_ops_is_within "$database" "$uploads" && luxora_ops_die 'database cannot be inside the uploads tree'
luxora_ops_is_within "$destination" "$blobs" && luxora_ops_die 'backup destination cannot be inside the blobs tree'
luxora_ops_is_within "$destination" "$uploads" && luxora_ops_die 'backup destination cannot be inside the uploads tree'
[[ "$destination" != "$database" ]] || luxora_ops_die 'backup destination cannot equal the database path'

luxora_ops_assert_safe_tree "$blobs" 'blobs tree'
luxora_ops_assert_safe_tree "$uploads" 'uploads tree'

if command -v lsof >/dev/null 2>&1; then
  if lsof -t -- "$database" "${database}-wal" "${database}-shm" 2>/dev/null | grep -q .; then
    luxora_ops_die 'the database or its WAL files are still open; stop the API before snapshotting'
  fi
fi

mkdir "$destination"
mkdir -p "$destination/payload/database" "$destination/payload/blobs" \
  "$destination/payload/uploads" "$destination/metadata"
printf 'Snapshot creation did not complete. Do not restore this directory.\n' >"$destination/metadata/INCOMPLETE"

sqlite3 -batch "$database" ".timeout 5000" ".backup '$destination/payload/database/luxora.db'"
# A backup of a WAL-mode source can retain WAL in the database header while no
# sidecars exist yet. Normalize the sealed copy to a standalone rollback journal
# so read-only verification never needs to create a new -shm file. Runtime will
# enable WAL again when the restored API opens its new database.
sqlite3 -batch "$destination/payload/database/luxora.db" 'PRAGMA journal_mode = DELETE;' >/dev/null
cp -R "$blobs/." "$destination/payload/blobs/"
cp -R "$uploads/." "$destination/payload/uploads/"

luxora_ops_assert_safe_tree "$destination/payload/blobs" 'copied blobs tree'
luxora_ops_assert_safe_tree "$destination/payload/uploads" 'copied uploads tree'
luxora_ops_check_database "$destination/payload/database/luxora.db"
luxora_ops_reconcile_local_payload \
  "$destination/payload/database/luxora.db" \
  "$destination/payload/blobs" \
  "$destination/payload/uploads"

created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
sqlite_version="$(sqlite3 -batch -noheader ':memory:' 'SELECT sqlite_version();')"
printf '%s\n' \
  'LUXORA_BACKUP_FORMAT=1' \
  'PRODUCT=Luxora' \
  'RELEASE=Beta-0.1' \
  'OWNER=Flenym' \
  'CONSISTENCY_MODE=offline_api_stopped' \
  'DATABASE_CAPTURE=sqlite_backup_api' \
  'STORAGE_DRIVER=local' \
  'UPLOAD_POLICY=included_for_inflight_resume' \
  "CREATED_AT_UTC=$created_at" \
  "SQLITE_VERSION=$sqlite_version" >"$destination/metadata/backup.env"
printf 'ok\n' >"$destination/metadata/integrity_check.txt"
printf 'ok\n' >"$destination/metadata/foreign_key_check.txt"
luxora_ops_write_migration_inventory \
  "$destination/payload/database/luxora.db" \
  "$destination/metadata/migrations.tsv"
printf '%s\n' \
  'This is an unencrypted local/offline preview snapshot.' \
  'It intentionally contains no runtime secrets or data-encryption keys.' \
  'SHA-256 detects corruption but is not an authenticated signature.' \
  'Restore requires the compatible external keyring and a new destination.' \
  'Passing verification is not a production backup/DR claim.' >"$destination/metadata/README.txt"

# Some SQLite builds can leave a stale, unreferenced -shm beside a database that
# has just transitioned away from WAL. Reassert standalone mode after the final
# inventory read, then remove only these two exact sidecar paths before sealing.
sqlite3 -batch "$destination/payload/database/luxora.db" 'PRAGMA journal_mode = DELETE;' >/dev/null
rm -f -- \
  "$destination/payload/database/luxora.db-wal" \
  "$destination/payload/database/luxora.db-shm"

mv "$destination/metadata/INCOMPLETE" "$destination/metadata/COMPLETE"
printf 'Snapshot sealed only after database, blob, upload and manifest validation.\n' \
  >"$destination/metadata/COMPLETE"
luxora_ops_harden_tree "$destination"
luxora_ops_generate_manifest "$destination"
luxora_ops_harden_tree "$destination"

"$script_directory/verify-local-backup.sh" --backup "$destination" >/dev/null

printf 'Luxora Beta-0.1 offline preview backup verified: %s\n' "$destination"
printf 'Next: restore it into a new destination and record the synthetic drill evidence.\n'
