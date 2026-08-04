#!/usr/bin/env bash

# Shared, side-effect-light helpers for the Luxora local preview recovery drill.
# Callers enable strict mode themselves so this file can also be sourced by tests.

luxora_ops_die() {
  printf 'luxora-ops: %s\n' "$*" >&2
  exit 1
}

luxora_ops_require_command() {
  command -v "$1" >/dev/null 2>&1 || luxora_ops_die "required command is unavailable: $1"
}

luxora_ops_require_absolute() {
  local value="$1"
  local label="$2"
  [[ "$value" == /* ]] || luxora_ops_die "$label must be an absolute path"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* ]] || \
    luxora_ops_die "$label contains a control character"
}

luxora_ops_canonical_existing() {
  local value="$1"
  local label="$2"
  luxora_ops_require_absolute "$value" "$label"
  [[ -e "$value" ]] || luxora_ops_die "$label does not exist: $value"
  [[ ! -L "$value" ]] || luxora_ops_die "$label must not be a symbolic link: $value"
  realpath "$value"
}

luxora_ops_canonical_new() {
  local value="$1"
  local label="$2"
  local parent
  local name
  luxora_ops_require_absolute "$value" "$label"
  [[ ! -e "$value" && ! -L "$value" ]] || luxora_ops_die "$label already exists: $value"
  parent="$(dirname "$value")"
  name="$(basename "$value")"
  [[ "$name" != "." && "$name" != ".." && -n "$name" ]] || luxora_ops_die "$label has an unsafe basename"
  [[ -d "$parent" && ! -L "$parent" ]] || luxora_ops_die "$label parent must be an existing, non-symlink directory"
  parent="$(realpath "$parent")"
  [[ "$parent" != "/" || "$name" != "" ]] || luxora_ops_die "$label resolves to a broad filesystem target"
  printf '%s/%s\n' "${parent%/}" "$name"
}

luxora_ops_is_within() {
  local candidate="$1"
  local root="$2"
  [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]]
}

luxora_ops_assert_distinct_roots() {
  local first="$1"
  local second="$2"
  local first_label="$3"
  local second_label="$4"
  if luxora_ops_is_within "$first" "$second" || luxora_ops_is_within "$second" "$first"; then
    luxora_ops_die "$first_label and $second_label must be separate, non-nested paths"
  fi
}

luxora_ops_validate_relative_name() {
  local relative="$1"
  local label="$2"
  [[ -n "$relative" && "$relative" != /* ]] || luxora_ops_die "$label is not relative"
  [[ "$relative" =~ ^[A-Za-z0-9._/-]+$ ]] || \
    luxora_ops_die "$label contains characters outside the preview-safe filename set: $relative"
  case "/$relative/" in
    *"/../"*|*"/./"*|*"//"*) luxora_ops_die "$label contains an unsafe path component: $relative" ;;
  esac
}

luxora_ops_assert_safe_tree() {
  local root="$1"
  local label="$2"
  local entry
  local relative
  [[ -d "$root" && ! -L "$root" ]] || luxora_ops_die "$label must be a non-symlink directory: $root"
  while IFS= read -r -d '' entry; do
    relative="${entry#"$root"/}"
    luxora_ops_validate_relative_name "$relative" "$label entry"
    [[ ! -L "$entry" ]] || luxora_ops_die "$label contains a symbolic link: $relative"
    [[ -d "$entry" || -f "$entry" ]] || luxora_ops_die "$label contains a special filesystem entry: $relative"
  done < <(find "$root" -mindepth 1 -print0)
}

luxora_ops_sha256() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    luxora_ops_die "sha256sum or shasum is required"
  fi
}

luxora_ops_file_size() {
  local path="$1"
  if stat -f '%z' "$path" >/dev/null 2>&1; then
    stat -f '%z' "$path"
  else
    stat -c '%s' "$path"
  fi
}

luxora_ops_mode() {
  local path="$1"
  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

luxora_ops_harden_tree() {
  local root="$1"
  find "$root" -type d -exec chmod 0700 {} +
  find "$root" -type f -exec chmod 0600 {} +
}

luxora_ops_assert_hardened_tree() {
  local root="$1"
  local entry
  local mode
  while IFS= read -r -d '' entry; do
    mode="$(luxora_ops_mode "$entry")"
    if [[ -d "$entry" ]]; then
      [[ "$mode" == "700" ]] || luxora_ops_die "directory permission is not 0700: ${entry#"$root"/} ($mode)"
    else
      [[ "$mode" == "600" ]] || luxora_ops_die "file permission is not 0600: ${entry#"$root"/} ($mode)"
    fi
  done < <(find "$root" -print0)
}

luxora_ops_table_exists() {
  local database="$1"
  local table="$2"
  [[ "$(sqlite3 -batch -noheader -readonly "$database" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$table';")" == "1" ]]
}

luxora_ops_check_database() {
  local database="$1"
  local integrity
  local foreign_keys
  integrity="$(sqlite3 -batch -noheader -readonly "$database" 'PRAGMA integrity_check;')"
  [[ "$integrity" == "ok" ]] || luxora_ops_die "SQLite integrity_check failed: $integrity"
  foreign_keys="$(sqlite3 -batch -noheader -readonly "$database" 'PRAGMA foreign_key_check;')"
  [[ -z "$foreign_keys" ]] || luxora_ops_die "SQLite foreign_key_check reported violations"
  luxora_ops_table_exists "$database" "schema_migrations" || \
    luxora_ops_die "schema_migrations is missing from the database"
}

luxora_ops_write_migration_inventory() {
  local database="$1"
  local destination="$2"
  sqlite3 -batch -noheader -readonly -separator $'\t' "$database" \
    'SELECT id, applied_at FROM schema_migrations ORDER BY rowid;' >"$destination"
}

luxora_ops_reconcile_local_payload() {
  local database="$1"
  local blobs="$2"
  local uploads="$3"
  local count
  local storage_key
  local upload_id
  local chunk_index

  if luxora_ops_table_exists "$database" "attachments"; then
    count="$(sqlite3 -batch -noheader -readonly "$database" \
      "SELECT count(*) FROM attachments WHERE storage_provider <> 'local' AND deleted_at IS NULL;")"
    [[ "$count" == "0" ]] || luxora_ops_die "database contains non-local active attachment records; this drill is local-storage-only"
    while IFS= read -r storage_key; do
      [[ -n "$storage_key" ]] || continue
      luxora_ops_validate_relative_name "$storage_key" "attachment storage_key"
      [[ -f "$blobs/$storage_key" && ! -L "$blobs/$storage_key" ]] || \
        luxora_ops_die "active attachment object is missing: $storage_key"
    done < <(sqlite3 -batch -noheader -readonly "$database" \
      "SELECT storage_key FROM attachments
       WHERE storage_provider = 'local' AND deleted_at IS NULL AND deleting_at IS NULL
       ORDER BY storage_key;")
  fi

  if luxora_ops_table_exists "$database" "upload_sessions"; then
    count="$(sqlite3 -batch -noheader -readonly "$database" \
      "SELECT count(*) FROM upload_sessions
       WHERE storage_provider <> 'local' AND status IN ('active', 'completing');")"
    [[ "$count" == "0" ]] || luxora_ops_die "database contains non-local in-flight uploads; this drill is local-storage-only"
  fi

  if luxora_ops_table_exists "$database" "upload_sessions" && luxora_ops_table_exists "$database" "upload_chunks"; then
    while IFS=$'\t' read -r upload_id chunk_index; do
      [[ -n "$upload_id" && -n "$chunk_index" ]] || continue
      luxora_ops_validate_relative_name "$upload_id" "upload id"
      [[ "$chunk_index" =~ ^[0-9]+$ ]] || luxora_ops_die "upload chunk index is invalid: $chunk_index"
      [[ -f "$uploads/$upload_id/$chunk_index.part" && ! -L "$uploads/$upload_id/$chunk_index.part" ]] || \
        luxora_ops_die "in-flight upload chunk is missing: $upload_id/$chunk_index.part"
    done < <(sqlite3 -batch -noheader -readonly -separator $'\t' "$database" \
      "SELECT c.upload_id, c.chunk_index
       FROM upload_chunks c
       JOIN upload_sessions s ON s.id = c.upload_id
       WHERE s.status IN ('active', 'completing')
       ORDER BY c.upload_id, c.chunk_index;")
  fi
}

luxora_ops_generate_manifest() {
  local backup="$1"
  local temporary="$backup/.SHA256SUMS.tmp"
  local relative
  local path
  : >"$temporary"
  while IFS= read -r relative; do
    luxora_ops_validate_relative_name "$relative" "manifest path"
    path="$backup/$relative"
    printf '%s\t%s\t%s\n' \
      "$(luxora_ops_sha256 "$path")" \
      "$(luxora_ops_file_size "$path")" \
      "$relative" >>"$temporary"
  done < <(
    cd "$backup"
    find payload metadata -type f -print | LC_ALL=C sort
  )
  chmod 0600 "$temporary"
  mv "$temporary" "$backup/SHA256SUMS"
  chmod 0600 "$backup/SHA256SUMS"
}
