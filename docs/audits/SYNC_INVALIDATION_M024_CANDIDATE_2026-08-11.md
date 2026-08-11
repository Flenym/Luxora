# Luxora Beta-0.1 — sync invalidation / migration 024 Docker candidate evidence

> **Rollback warning added after the isolated run:** this document proves the
> original `f93a22cd…` smoke only. A later remove/re-add probe proved that image
> is not a safe rollback or promotion artifact for a database with migration
> `024`: it attempts to recreate a removed membership at revision `1`, while
> the ledger requires `last_revision + 1`. Do not promote or roll back to that
> image on an `024` database. The schema-compatible replacement and evidence
> are recorded in
> [SYNC_INVALIDATION_SCHEMA_COMPATIBLE_FALLBACK_2026-08-11.md](SYNC_INVALIDATION_SCHEMA_COMPATIBLE_FALLBACK_2026-08-11.md).

**Date:** 11 August 2026

**Owner/developer:** Flenym

**Disposition:** isolated candidate verification passed; this audit did not
promote or modify the live API.

## Exact artifact

- Tag: `luxora-api:sync-invalidation-m024-candidate-20260811`.
- OCI repository digest and image ID:
  `sha256:f93a22cd79d40209bd964e8a9693a9abb145301b37f0431396bed62a9db53ec5`.
- Platform: `linux/arm64`.
- Entrypoint: `/nodejs/bin/node`; command:
  `--enable-source-maps dist/server.js`.
- Configured UID/GID: `65532:65532`. The isolated runtime process was also
  observed as numeric user `65532`.
- A direct `/bin/sh` entrypoint probe failed with exit code `127` because the
  shell is absent.

## Trivy release gate

Trivy `0.73.0` scanned the exact local tag above through the Docker socket.
Separate JSON scans were limited to release-blocking severities and produced:

| Scanner | High | Critical |
|---|---:|---:|
| Vulnerabilities | 0 | 0 |
| Secrets | 0 | 0 |

Both JSON documents used Trivy schema version `2`, identified the artifact as
`container_image`, and contained two scanned result targets. No finding body or
secret value was printed by the aggregate-only summarizer.

Point-in-time verifier hashes:

- vulnerability JSON:
  `87c13816c009cd167574063b59fbf6ca7899aa433b57a1339ea5be58c1ea7aac`;
- secret JSON:
  `34fc5e3f763b7a3590bea389fabc3d8c2a027cef4bf7143e0390590e2a68a37a`.

## Isolated runtime smoke

The final evidence run used a new disposable named data volume and published
container port `8080` only to an automatically allocated loopback listener,
`127.0.0.1:57840`. It ran with:

- a read-only root filesystem;
- `cap_drop=ALL`;
- `no-new-privileges`;
- a constrained `/tmp` tmpfs;
- independent, audit-only JWT, data-encryption and phone-HMAC material;
- the development phone provider solely inside the disposable runtime.

Secret material, access/registration tokens and the verification code are not
stored in this report or in the sanitized smoke result.

Observed assertions all passed:

- `/health/live`: `status=ok`;
- `/health/ready`: `status=ready`;
- `/v1/capabilities`: phone authentication, chat folders, realtime and
  reconciliation enabled; realtime version `2` preferred;
- phone challenge, verification, new-profile registration and authenticated
  `/v1/me` completed;
- one account-scoped chat folder was created and returned by the list route;
- the initial reconciliation boundary was `B1=1` and advertised
  `resources.chatFolders=/v1/chat-folders` with `chat_folders` in the reset
  collection set;
- a real profile mutation generated sequence `2` and advanced the next
  snapshot to `B2=2`;
- realtime V2 delivered the event live and replayed the same sequence from the
  B1 scoped cursor;
- the event was exactly `sync.invalidated` with
  `audience=account_projection`, `accountId` equal to the authenticated account
  and `reason=profile_updated`;
- realtime V1 did not receive `sync.invalidated`;
- the persisted invalidation row had the same self-account audience and entity,
  with no additional invalidation row after B1.

The sanitized smoke-result SHA-256 was
`75b4068b33c03ee806cb9b450c43e6239fbde9edbaa973f2f94aa960a0613f4a`.

## Database evidence

The candidate-created SQLite database was opened independently in read-only
mode after the HTTP and realtime assertions:

- applied migrations: `24`;
- latest migration: `024_chat_membership_revision_ledger`;
- `PRAGMA foreign_key_check`: zero rows;
- `PRAGMA integrity_check`: `ok`.

## Reproducibility note and cleanup

A preliminary disposable pass completed the application assertions but the
external read-only verifier used an incorrect dependency mount and failed
before opening SQLite. That candidate and its volume were fully removed. The
successful evidence above was then reproduced from a newly created empty
volume after verifying the helper dependency mount; it is not based on the
partially populated preliminary database.

After the successful pass, the exact disposable container
`luxora-sync-audit-20260811` and volume
`luxora_sync_audit_data_20260811` were stopped and removed. Both inspect calls
then returned absent. The before/after running-container inventory was
unchanged: the existing live API remained on `127.0.0.1:8080`, the OTP console
remained on `127.0.0.1:8081`, and neither live container nor any live volume was
stopped, restarted, mounted or modified by this audit.

This is point-in-time local candidate evidence. The candidate image remains
available under the exact tag and digest above; no deployment or promotion is
claimed.
