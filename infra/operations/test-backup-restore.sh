#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$script_directory/common.sh"

luxora_ops_require_command sqlite3
luxora_ops_require_command mktemp

test_directory="$(mktemp -d "${TMPDIR:-/tmp}/luxora-backup-restore-test.XXXXXX")"
cleanup_test_directory() {
  case "$test_directory" in
    /tmp/luxora-backup-restore-test.*|/private/tmp/luxora-backup-restore-test.*|"${TMPDIR:-/tmp}"/luxora-backup-restore-test.*)
      rm -rf -- "$test_directory"
      ;;
    *) printf 'luxora-ops: refusing unsafe test cleanup path: %s\n' "$test_directory" >&2 ;;
  esac
}
trap cleanup_test_directory EXIT

source_root="$test_directory/source"
database="$source_root/luxora.db"
blobs="$source_root/blobs"
uploads="$source_root/uploads"
backup="$test_directory/backup"
restore="$test_directory/restore"
mkdir -p "$blobs/attachments/aa/account-a" "$uploads/upload-a"

printf 'encrypted-blob-fixture\n' >"$blobs/attachments/aa/account-a/upload-a"
printf 'encrypted-staging-chunk-fixture\n' >"$uploads/upload-a/0.part"

sqlite3 "$database" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
INSERT INTO schema_migrations VALUES ('001_test', '2026-08-03T00:00:00.000Z');
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  storage_provider TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  deleted_at TEXT,
  deleting_at TEXT
) STRICT;
INSERT INTO attachments VALUES (
  'attachment-a', 'local', 'attachments/aa/account-a/upload-a', NULL, NULL
);
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  storage_provider TEXT NOT NULL,
  status TEXT NOT NULL
) STRICT;
INSERT INTO upload_sessions VALUES ('upload-a', 'local', 'active');
CREATE TABLE upload_chunks (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id),
  chunk_index INTEGER NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
) STRICT;
INSERT INTO upload_chunks VALUES ('upload-a', 0);
CREATE TABLE drill_marker (
  value TEXT NOT NULL
) STRICT;
INSERT INTO drill_marker VALUES ('synthetic-restore-ok');
SQL

"$script_directory/backup-local-preview.sh" \
  --database "$database" \
  --blobs "$blobs" \
  --uploads "$uploads" \
  --destination "$backup" \
  --confirm-api-stopped
"$script_directory/verify-local-backup.sh" --backup "$backup"
"$script_directory/restore-local-preview.sh" --backup "$backup" --destination "$restore"

[[ "$(sqlite3 -batch -noheader -readonly "$restore/luxora.db" 'SELECT value FROM drill_marker;')" == 'synthetic-restore-ok' ]] || \
  luxora_ops_die 'synthetic database marker was not restored'
cmp -s "$blobs/attachments/aa/account-a/upload-a" "$restore/blobs/attachments/aa/account-a/upload-a" || \
  luxora_ops_die 'synthetic blob was not restored byte-for-byte'
cmp -s "$uploads/upload-a/0.part" "$restore/uploads/upload-a/0.part" || \
  luxora_ops_die 'synthetic upload staging chunk was not restored byte-for-byte'

if "$script_directory/restore-local-preview.sh" --backup "$backup" --destination "$restore" >/dev/null 2>&1; then
  luxora_ops_die 'restore unexpectedly accepted an existing destination'
fi

backup_link="$test_directory/backup-link"
ln -s "$backup" "$backup_link"
if "$script_directory/verify-local-backup.sh" --backup "$backup_link" >/dev/null 2>&1; then
  luxora_ops_die 'verification unexpectedly accepted a symlink backup root'
fi

tampered="$test_directory/tampered-backup"
cp -R "$backup" "$tampered"
chmod 0600 "$tampered/payload/blobs/attachments/aa/account-a/upload-a"
printf 'tamper\n' >>"$tampered/payload/blobs/attachments/aa/account-a/upload-a"
if "$script_directory/verify-local-backup.sh" --backup "$tampered" >/dev/null 2>&1; then
  luxora_ops_die 'verification unexpectedly accepted a tampered payload'
fi

printf 'Luxora Beta-0.1 synthetic offline backup/restore drill PASS.\n'
