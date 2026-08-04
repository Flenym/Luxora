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
    '  restore-local-preview.sh --backup /absolute/backup-directory \' \
    '    --destination /absolute/new-restore-directory'
}

backup_input=""
destination_input=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) [[ $# -ge 2 ]] || luxora_ops_die '--backup requires a value'; backup_input="$2"; shift 2 ;;
    --destination) [[ $# -ge 2 ]] || luxora_ops_die '--destination requires a value'; destination_input="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) luxora_ops_die "unknown argument: $1" ;;
  esac
done
[[ -n "$backup_input" && -n "$destination_input" ]] || { usage >&2; exit 2; }

backup="$(luxora_ops_canonical_existing "$backup_input" 'backup directory')"
destination="$(luxora_ops_canonical_new "$destination_input" 'restore destination')"
luxora_ops_is_within "$destination" "$backup" && luxora_ops_die 'restore destination cannot be inside the backup'
luxora_ops_is_within "$backup" "$destination" && luxora_ops_die 'backup cannot be inside the restore destination'

"$script_directory/verify-local-backup.sh" --backup "$backup"

mkdir "$destination"
printf 'Restore did not complete. Do not start the API with this directory.\n' >"$destination/.RESTORE_INCOMPLETE"
mkdir "$destination/blobs" "$destination/uploads"
cp "$backup/payload/database/luxora.db" "$destination/luxora.db"
cp -R "$backup/payload/blobs/." "$destination/blobs/"
cp -R "$backup/payload/uploads/." "$destination/uploads/"

luxora_ops_assert_safe_tree "$destination/blobs" 'restored blobs tree'
luxora_ops_assert_safe_tree "$destination/uploads" 'restored uploads tree'
luxora_ops_check_database "$destination/luxora.db"
luxora_ops_reconcile_local_payload "$destination/luxora.db" "$destination/blobs" "$destination/uploads"

while IFS=$'\t' read -r expected_hash expected_size relative extra; do
  [[ -z "${extra:-}" ]] || luxora_ops_die 'manifest row has unexpected fields during restore verification'
  case "$relative" in
    payload/database/luxora.db) restored="$destination/luxora.db" ;;
    payload/blobs/*) restored="$destination/blobs/${relative#payload/blobs/}" ;;
    payload/uploads/*) restored="$destination/uploads/${relative#payload/uploads/}" ;;
    metadata/*) continue ;;
    *) luxora_ops_die "unexpected payload path during restore: $relative" ;;
  esac
  [[ -f "$restored" && ! -L "$restored" ]] || luxora_ops_die "restored file is missing: $relative"
  [[ "$(luxora_ops_file_size "$restored")" == "$expected_size" ]] || luxora_ops_die "restored size mismatch: $relative"
  [[ "$(luxora_ops_sha256 "$restored")" == "$expected_hash" ]] || luxora_ops_die "restored SHA-256 mismatch: $relative"
done <"$backup/SHA256SUMS"

temporary_migrations="$destination/.migrations.restore.tmp"
luxora_ops_write_migration_inventory "$destination/luxora.db" "$temporary_migrations"
cmp -s "$temporary_migrations" "$backup/metadata/migrations.tsv" || luxora_ops_die 'restored migration inventory mismatch'
rm "$temporary_migrations"

restored_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
manifest_digest="$(luxora_ops_sha256 "$backup/SHA256SUMS")"
printf '%s\n' \
  'Luxora local preview restore verification' \
  'Release: Beta-0.1' \
  'Owner and developer: Flenym' \
  "Restored at UTC: $restored_at" \
  "SHA256SUMS digest: $manifest_digest" \
  'SQLite integrity_check: ok' \
  'SQLite foreign_key_check: ok' \
  'Manifest payload hashes: ok' \
  'Migration inventory: matched' \
  'Blob/upload reconciliation: passed' \
  'Production backup/DR gate: NOT CLAIMED' >"$destination/RESTORE_VERIFICATION.txt"
luxora_ops_harden_tree "$destination"
luxora_ops_assert_hardened_tree "$destination"
mv "$destination/.RESTORE_INCOMPLETE" "$destination/.RESTORE_COMPLETE"
printf 'Restore completed and independently verified.\n' >"$destination/.RESTORE_COMPLETE"
chmod 0600 "$destination/.RESTORE_COMPLETE"
luxora_ops_assert_hardened_tree "$destination"

printf 'Luxora Beta-0.1 offline preview restore PASS: %s\n' "$destination"
printf 'Configure DATABASE_PATH=%s/luxora.db, STORAGE_LOCAL_PATH=%s/blobs and UPLOAD_STAGING_PATH=%s/uploads only in an isolated preview.\n' \
  "$destination" "$destination" "$destination"
