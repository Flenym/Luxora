# READ-ONLY PRECHECK / NOT YET DEPLOYED

# Luxora Beta-0.1 — chat-folders live promotion precheck

**Date:** 11 August 2026

**Owner/developer:** Flenym

**Scope:** local Docker preview API and iPhone reconciliation compatibility

This document records a read-only inspection and the required promotion and
rollback procedure. The inspection did not stop, restart, create, remove or
modify containers, images, volumes, files, database rows or host listeners.
No runtime secret, credential, access token, password, verification code or
OTP value was read into this document.

## 1. Verified live boundary

The current API is healthy and bound only to `127.0.0.1:8080`:

- container: `luxora-phone-live`;
- image tag: `luxora-api:chat-preferences-realtime-live-20260811`;
- image ID:
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`;
- database: `/app/data/luxora-phone-live.db`;
- Docker volume: `luxora_phone_live_data`;
- applied migrations: 21;
- latest migration: `021_push_registration_preferences`;
- `PRAGMA integrity_check`: `ok`;
- `PRAGMA foreign_key_check`: zero rows.

Observed business counts at precheck time were:

| Entity | Count |
|---|---:|
| Users | 35 |
| Device sessions | 44 |
| Refresh tokens | 49 |
| Chats | 11 |
| Messages | 10 |
| Push registrations | 1 |

These counts are evidence for the inspection instant only. They must be
captured again after writes are stopped and before the promotion backup is
sealed.

The current container hardening was also confirmed:

- configured UID/GID `65532:65532`;
- read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- only `/app/data` is writable;
- API publication is limited to `127.0.0.1:8080`;
- restart policy is `unless-stopped`.

Current `/v1/capabilities` correctly does not advertise chat folders. The live
runtime remains on the 11-collection reconciliation boundary.

## 2. OTP console and host ports

The separate development OTP console is healthy on `127.0.0.1:8081`. It is
non-root, read-only, capability-dropped and attached to its separate developer
network. It has no data-volume mount and must remain untouched during the API
promotion.

Relevant listeners found during the precheck were:

- `127.0.0.1:8080` — current live API;
- `127.0.0.1:8081` — development OTP console;
- `127.0.0.1:18082` — disposable auth-v2 candidate;
- port `18085` — free after final-candidate smoke cleanup.

Do not print or persist the value returned by the OTP console. A phone-auth
smoke must pass it directly through a non-verbose process or a mode-`0600`
temporary file.

## 3. Exact final candidate

The immutable candidate is:

```text
luxora-api@sha256:a76701b1a37610bd9bcf31c41d668645a983744bf256e47fbef9726c6af2ba5b
```

Verified metadata:

- tag: `luxora-api:chat-folders-final-candidate-20260811`;
- platform: `linux/arm64`;
- configured and observed UID/GID: `65532:65532`;
- distroless Node `v22.23.2` runtime;
- final Trivy gate: 0 High, 0 Critical and 0 secret findings;
- isolated health, capabilities and authenticated folder smoke passed;
- isolated database reached 23 migrations with
  `023_chat_folder_receipt_retention` last;
- isolated integrity check was `ok` and FK violations were zero;
- authenticated reconciliation returned exactly 12 unique reset collections,
  including `chat_folders`, with
  `resources.chatFolders=/v1/chat-folders`.

The earlier `c293…` and `3bd…` builds are stale and must never be promoted.

## 4. Mandatory hold points

Promotion must not begin until both gates pass:

1. The signed iPhone build successfully consumes the authenticated
   12-collection snapshot, including `chat_folders`, and completes its live
   chat-folder client flow.
2. A new stopped-service `pre-chat-folders-*` backup is created, verified and
   restore-rehearsed immediately before the switch.

The latest existing sealed backup is structurally valid but stale:

```text
/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/
pre-chat-preferences-realtime-20260811T092807Z
```

Its nine manifest entries passed exact SHA-256 and size verification. Its
directories are mode `0700`, files are mode `0600`, integrity/FK checks pass,
and it ends at migration `021`. Its database contains 32 users, 41 device
sessions, 46 refresh tokens, 7 chats, 8 messages and 1 push registration.
Because current live already contains 35 users and 44 sessions, this archive
must not be treated as the promotion rollback point.

## 5. Secure promotion preparation

Use exact names and the immutable digest:

```bash
PROMOTION_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CURRENT_CONTAINER="luxora-phone-live"
ROLLBACK_CONTAINER="luxora-phone-live-pre-chat-folders-${PROMOTION_STAMP}"
CANDIDATE_IMAGE="luxora-api@sha256:a76701b1a37610bd9bcf31c41d668645a983744bf256e47fbef9726c6af2ba5b"
BACKUP_DEST="/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-chat-folders-${PROMOTION_STAMP}"
PROMOTION_TEMP="$(mktemp -d /private/tmp/luxora-chat-folders-promotion.XXXXXX)"
RUNTIME_ENV="${PROMOTION_TEMP}/runtime.env"
RAW_COPY="${PROMOTION_TEMP}/raw"
RESTORE_CHECK="${PROMOTION_TEMP}/restore-check"
umask 077
mkdir -m 0700 "$RAW_COPY"
```

Install a cleanup trap that accepts only the exact
`/private/tmp/luxora-chat-folders-promotion.*` pattern. Do not use `$HOME`, `~`,
an unresolved path or a broad recursive target. Do not enable shell tracing.

Capture the existing container environment directly into a private file;
never route it to the terminal:

```bash
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$CURRENT_CONTAINER" >"$RUNTIME_ENV"
chmod 0600 "$RUNTIME_ENV"
test "$(stat -f %Lp "$RUNTIME_ENV")" = "600"
```

Use quiet `grep -q` presence checks, without displaying values, for:

- `JWT_SECRET`;
- `DATA_ENCRYPTION_KEYS`;
- `ACTIVE_DATA_ENCRYPTION_KEY_ID`;
- `PHONE_AUTH_HMAC_SECRET`;
- `PHONE_AUTH_DEVELOPMENT_CODE`.

Before stopping live, record the candidate image ID, current image ID,
liveness, readiness, OTP-console health, database counts, migration inventory,
integrity and FK results.

## 6. Offline backup and restore rehearsal

Stop writes and require a clean exit:

```bash
docker stop --time 30 "$CURRENT_CONTAINER"
```

Require all of the following before copying data:

- container state is `exited`;
- exit code is `0`;
- nothing listens on `127.0.0.1:8080`.

The live database has active WAL/SHM sidecars while running. Copy the complete
stopped `/app/data` tree, never only the main `.db` file:

```bash
docker cp "${CURRENT_CONTAINER}:/app/data/." "$RAW_COPY/"
```

Create the new sealed backup:

```bash
infra/operations/backup-local-preview.sh \
  --database "${RAW_COPY}/luxora-phone-live.db" \
  --blobs "${RAW_COPY}/blobs" \
  --uploads "${RAW_COPY}/uploads" \
  --destination "$BACKUP_DEST" \
  --confirm-api-stopped

infra/operations/verify-local-backup.sh \
  --backup "$BACKUP_DEST"
```

Rehearse restoration into the new, previously nonexistent temporary target:

```bash
infra/operations/restore-local-preview.sh \
  --backup "$BACKUP_DEST" \
  --destination "$RESTORE_CHECK"
```

The fresh archive and restored copy must prove:

- migration inventory ends at `021_push_registration_preferences`;
- every pre-migration business-table count matches the stopped raw copy;
- `PRAGMA integrity_check` is `ok`;
- `PRAGMA foreign_key_check` returns zero rows;
- manifest hashes and sizes match;
- durable blob and upload-staging reconciliation passes;
- no runtime key, OTP or other secret is present in the archive.

Do not proceed if any check differs. Keep the stopped original container and
restart it unchanged instead.

## 7. Live switch

Only after the fresh backup and restore rehearsal pass, preserve the current
`c514…` container as the immediate rollback artifact:

```bash
docker rename "$CURRENT_CONTAINER" "$ROLLBACK_CONTAINER"
```

Start the exact candidate digest with the same environment and data volume:

```bash
docker run --detach \
  --name "$CURRENT_CONTAINER" \
  --restart unless-stopped \
  --user 65532:65532 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume luxora_phone_live_data:/app/data:z \
  --publish 127.0.0.1:8080:8080 \
  --env-file "$RUNTIME_ENV" \
  "$CANDIDATE_IMAGE"
```

Never start the rollback and candidate containers together against the shared
volume.

## 8. Required post-switch gates

Before any authenticated mutation, require:

- container health is `healthy`;
- `/health/live` returns HTTP `200`, `status=ok`, release `Beta-0.1`;
- `/health/ready` returns HTTP `200`, `status=ready`;
- actual image ID is exactly `a767…`;
- UID/GID, read-only root, dropped capabilities, `no-new-privileges`, writable
  volume boundary and localhost-only publication remain intact;
- 23 migrations are applied;
- latest migration is `023_chat_folder_receipt_retention`;
- `PRAGMA integrity_check` is `ok`;
- `PRAGMA foreign_key_check` returns zero rows;
- every pre-existing business-table count equals the fresh stopped-service
  backup baseline.

Capabilities must advertise:

| Capability | Expected value |
|---|---:|
| `features.chatFolders` | `true` |
| `maxChatFolders` | 10 |
| `maxChatFolderTitleLength` | 48 |
| `maxChatFolderOverrides` | 100 |
| `chatFolderIdempotencyTtlSeconds` | 86400 |
| `maxChatFolderActiveCommandReceipts` | 64 |

The authenticated smoke must then prove:

1. Registration or login succeeds without exposing credentials.
2. Initial folder state is revision `0` with no custom folders.
3. First create returns HTTP `201` and state revision `1`.
4. Reusing its nonce with a semantically equivalent reordered `includeKinds`
   payload returns the identical folder/revision and `replayed=true`.
5. A second create advances the state to revision `2`.
6. Reorder with `expectedStateRevision=2` returns HTTP `200` and revision `3`.
7. A second reorder using stale revision `2` returns HTTP `409` with
   `CONFLICT`.
8. Final list returns the two folders in committed order at revision `3`.
9. Authenticated `/v2/sync/snapshot` returns exactly 12 unique reset
   collections, contains `chat_folders`, and reports
   `resources.chatFolders=/v1/chat-folders`.
10. The signed iPhone live flow consumes the same snapshot and folder state.

Finally, recheck OTP-console health on `127.0.0.1:8081`. Tokens, credentials,
nonces and verification values must remain in memory or mode-`0600` temporary
files and must not appear in output or logs.

After every gate passes, unlink the temporary runtime environment and remove
only the exact guarded promotion temporary directory. Retain the sealed backup,
rollback container, live volume, OTP console and candidate image.

## 9. Immediate code rollback

If candidate startup or any gate fails, never run old and new code concurrently:

```bash
docker stop --time 30 luxora-phone-live
docker rename luxora-phone-live \
  "luxora-phone-live-failed-chat-folders-${PROMOTION_STAMP}"
docker rename "$ROLLBACK_CONTAINER" luxora-phone-live
docker start luxora-phone-live
```

Then verify old image ID `c514…`, health, integrity, FK results, retained
business counts and OTP-console health.

Migration inspection indicates this code rollback is schema-compatible:
`022/023` are additive and the old migration runner ignores migration IDs that
are newer than its compiled list. The chat-folder tables remain unused by the
old runtime. This is an inference from the reviewed migration runner and schema;
an isolated candidate-to-old-image clone rehearsal is still recommended before
the live switch.

The old server exposes the 11-collection contract. A strict snapshot-12 iPhone
build therefore requires a simultaneous client rollback or a forward server
fix.

## 10. Last-resort data rollback

Restoring migration-021 data discards every write committed after the fresh
backup. It requires an explicit data-loss decision.

If necessary:

1. Preserve the failed candidate container and migrated
   `luxora_phone_live_data` volume unchanged.
2. Verify the fresh sealed backup again.
3. Restore it into a new host directory.
4. Create a new uniquely named Docker volume.
5. Copy the restored database into that volume as
   `/app/data/luxora-phone-live.db`, together with `blobs` and `uploads`.
6. Start exact old image `c514…` against the new volume using a newly extracted
   mode-`0600` environment file.
7. Require migration `021`, exact sealed counts, clean integrity/FK, health,
   authentication and OTP-console gates.

Never delete migration rows, drop the folder tables or overwrite the current
live volume in place.

## 11. Disposable and retained inventory

These resources were active during the precheck and must not be removed until
their owning workstreams confirm completion:

- `luxora-folder-test-20260811`;
- `luxora-auth-v2-candidate-20260811` on `127.0.0.1:18082`;
- volume `luxora_auth_v2_candidate_20260811`.

Likely disposable after owner confirmation:

- `luxora-phone-candidate-clone-20260811`;
- `luxora-phone-candidate-clone-v2-20260811`;
- `luxora-phone-candidate-clone-v3-20260811`;
- volumes `luxora_phone_candidate_data_20260811`,
  `luxora_phone_candidate_data_20260811_v2` and
  `luxora_phone_candidate_data_20260811_v3`;
- created-only container `luxora-api-1`.

Do not remove `luxora_luxora_api_data` without first proving whether it contains
legacy user data. Retain after promotion:

- the new `luxora-phone-live` candidate container;
- the fresh `luxora-phone-live-pre-chat-folders-*` rollback container;
- `luxora_phone_live_data`;
- the fresh sealed `pre-chat-folders-*` backup;
- candidate image `a767…`;
- `luxora-otp-console-1`.

Older rollback containers and images may be reviewed only after the new rollback
path and retention window are confirmed. Their presence does not block the
promotion.
