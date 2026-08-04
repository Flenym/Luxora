#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$script_directory/common.sh"

usage() {
  printf 'Usage: verify-local-backup.sh --backup /absolute/backup-directory\n'
}

backup_input=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) [[ $# -ge 2 ]] || luxora_ops_die '--backup requires a value'; backup_input="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) luxora_ops_die "unknown argument: $1" ;;
  esac
done
[[ -n "$backup_input" ]] || { usage >&2; exit 2; }

luxora_ops_require_command realpath
luxora_ops_require_command sqlite3
luxora_ops_require_command find
luxora_ops_require_command awk

backup="$(luxora_ops_canonical_existing "$backup_input" 'backup directory')"
[[ -d "$backup" && ! -L "$backup" ]] || luxora_ops_die 'backup must be a non-symlink directory'
[[ -d "$backup/payload/database" && -d "$backup/payload/blobs" && -d "$backup/payload/uploads" ]] || \
  luxora_ops_die 'backup payload layout is incomplete'
[[ -d "$backup/metadata" && -f "$backup/SHA256SUMS" && ! -L "$backup/SHA256SUMS" ]] || \
  luxora_ops_die 'backup metadata or SHA256SUMS is missing'
[[ -f "$backup/metadata/COMPLETE" && ! -e "$backup/metadata/INCOMPLETE" ]] || \
  luxora_ops_die 'backup is not marked complete'

while IFS= read -r -d '' root_entry; do
  case "$(basename "$root_entry")" in
    payload|metadata|SHA256SUMS) ;;
    *) luxora_ops_die "unexpected item at backup root: $(basename "$root_entry")" ;;
  esac
done < <(find "$backup" -mindepth 1 -maxdepth 1 -print0)

luxora_ops_assert_safe_tree "$backup/payload" 'backup payload'
luxora_ops_assert_safe_tree "$backup/metadata" 'backup metadata'
luxora_ops_assert_hardened_tree "$backup"

grep -qx 'LUXORA_BACKUP_FORMAT=1' "$backup/metadata/backup.env" || luxora_ops_die 'unsupported backup format'
grep -qx 'PRODUCT=Luxora' "$backup/metadata/backup.env" || luxora_ops_die 'backup product metadata mismatch'
grep -qx 'RELEASE=Beta-0.1' "$backup/metadata/backup.env" || luxora_ops_die 'backup release metadata mismatch'
grep -qx 'OWNER=Flenym' "$backup/metadata/backup.env" || luxora_ops_die 'backup ownership metadata mismatch'
grep -qx 'CONSISTENCY_MODE=offline_api_stopped' "$backup/metadata/backup.env" || \
  luxora_ops_die 'backup was not created under the offline policy'
grep -qx 'STORAGE_DRIVER=local' "$backup/metadata/backup.env" || luxora_ops_die 'backup is not local-storage-only'

previous=""
manifest_count=0
while IFS=$'\t' read -r expected_hash expected_size relative extra; do
  [[ -z "${extra:-}" ]] || luxora_ops_die 'manifest row has unexpected fields'
  [[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || luxora_ops_die 'manifest contains an invalid SHA-256 value'
  [[ "$expected_size" =~ ^[0-9]+$ ]] || luxora_ops_die 'manifest contains an invalid size'
  luxora_ops_validate_relative_name "$relative" 'manifest path'
  [[ "$relative" == payload/* || "$relative" == metadata/* ]] || luxora_ops_die 'manifest path is outside sealed trees'
  if [[ -n "$previous" ]]; then
    [[ "$relative" > "$previous" ]] || luxora_ops_die 'manifest paths are duplicated or not sorted'
  fi
  previous="$relative"
  path="$backup/$relative"
  [[ -f "$path" && ! -L "$path" ]] || luxora_ops_die "manifest file is missing: $relative"
  [[ "$(luxora_ops_file_size "$path")" == "$expected_size" ]] || luxora_ops_die "size mismatch: $relative"
  [[ "$(luxora_ops_sha256 "$path")" == "$expected_hash" ]] || luxora_ops_die "SHA-256 mismatch: $relative"
  manifest_count=$((manifest_count + 1))
done <"$backup/SHA256SUMS"

actual_count="$(find "$backup/payload" "$backup/metadata" -type f | wc -l | tr -d '[:space:]')"
[[ "$manifest_count" -gt 0 && "$manifest_count" == "$actual_count" ]] || \
  luxora_ops_die "manifest file count mismatch (manifest=$manifest_count actual=$actual_count)"

database="$backup/payload/database/luxora.db"
[[ -f "$database" && ! -L "$database" ]] || luxora_ops_die 'backup database is missing'
luxora_ops_check_database "$database"
luxora_ops_reconcile_local_payload "$database" "$backup/payload/blobs" "$backup/payload/uploads"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/luxora-verify.XXXXXX")"
cleanup_verification_temp() {
  case "$temporary_directory" in
    /tmp/luxora-verify.*|/private/tmp/luxora-verify.*|"${TMPDIR:-/tmp}"/luxora-verify.*)
      rm -rf -- "$temporary_directory"
      ;;
    *) printf 'luxora-ops: refusing unsafe temporary cleanup path: %s\n' "$temporary_directory" >&2 ;;
  esac
}
trap cleanup_verification_temp EXIT
luxora_ops_write_migration_inventory "$database" "$temporary_directory/migrations.tsv"
cmp -s "$temporary_directory/migrations.tsv" "$backup/metadata/migrations.tsv" || \
  luxora_ops_die 'migration inventory does not match the sealed database'

printf 'Luxora Beta-0.1 backup verification PASS: %s files, SQLite integrity ok.\n' "$manifest_count"
