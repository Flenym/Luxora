# Luxora Beta-0.1 — promotion backup safety blocker

**Date:** 11 August 2026

**Owner/developer:** Flenym

**Decision:** `BLOCKED` before backup or restore rehearsal. The live API was not
stopped, paused, restarted, remounted or promoted.

## Why the requested online checkpoint cannot be claimed

The repository has one supported real-data backup workflow and it is explicitly
offline:

- `infra/operations/backup-local-preview.sh` requires
  `--confirm-api-stopped` and refuses to continue when the database, WAL or SHM
  files are still open;
- the sealed metadata records `CONSISTENCY_MODE=offline_api_stopped`;
- `infra/operations/verify-local-backup.sh` rejects any other consistency mode;
- `infra/operations/README.md`, `DATABASE.md` and `DEPLOY.md` all state that the
  API must be stopped so SQLite, durable blobs and resumable upload staging are
  captured inside the same offline window;
- those documents explicitly list online backup coordination as unimplemented.

SQLite's online backup API could independently provide a transactionally
consistent database file, but the current application has no tested quiesce or
snapshot protocol that binds that database boundary to concurrent local
`blobs/` and `uploads/` changes. A database-only or raw DB/WAL copy would
therefore not satisfy the repository's recoverable promotion-backup contract.
Passing `--confirm-api-stopped` while live is running would be a false safety
attestation and was not attempted.

The live dataset currently includes two attachment rows, one upload-session row
and one upload-chunk row, so local object and staging reconciliation is not an
empty theoretical concern.

## Read-only live boundary

The following was collected without reading or printing the container
environment or any runtime secret:

- container: `luxora-phone-live`;
- image tag: `luxora-api:chat-preferences-realtime-live-20260811`;
- image ID:
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`;
- Docker volume: `luxora_phone_live_data`, mounted read-write by live at
  `/app/data`;
- database: `/app/data/luxora-phone-live.db`;
- WAL sidecars present: `luxora-phone-live.db-wal` and
  `luxora-phone-live.db-shm`;
- local storage roots: `/app/data/blobs` and `/app/data/uploads`;
- journal mode: `wal`;
- host publication: `127.0.0.1:8080 -> 8080/tcp`;
- state: running and healthy; `/health/ready` returned `status=ready`;
- configured UID/GID: `65532:65532`;
- read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, restart policy `unless-stopped`.

A separate capability-dropped, network-disabled helper mounted the live volume
read-only and opened SQLite with `query_only` inside one read transaction. It
observed:

| Check | Result |
|---|---:|
| Applied migrations | 21 |
| Latest migration | `021_push_registration_preferences` |
| `PRAGMA integrity_check` | `ok` |
| Foreign-key violations | 0 |
| Users | 35 |
| Device sessions | 44 |
| Refresh tokens | 49 |
| Chats | 11 |
| Messages | 10 |
| Attachments | 2 |
| Upload sessions | 1 |
| Upload chunks | 1 |
| Realtime events | 72 |

These counts describe the read transaction only; no content, identity, token,
phone number, OTP or encryption material was selected.

## Existing sealed backup is valid but stale

The latest existing archive remains:

```text
/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/
pre-chat-preferences-realtime-20260811T092807Z
```

The repository verifier passed it again: nine manifest entries, restrictive
root mode `0700`, SQLite integrity and foreign keys valid, 21 migrations with
`021_push_registration_preferences` last. Its `SHA256SUMS` digest is:

```text
96de2551471151bee6958a0d812483ca2b28ae95b64df10bde8a5a4972bfa09a
```

It contains 32 users, 41 device sessions, 46 refresh tokens, 7 chats, 8
messages, 2 attachments, 1 upload session, 1 upload chunk and 46 realtime
events. The current live read had 35 users, 44 sessions, 49 refresh tokens, 11
chats, 10 messages and 72 realtime events. The existing archive is therefore
not a fresh rollback checkpoint for migration 024 promotion.

## Candidate and no-change evidence

The intended candidate is still available locally and was only inspected:

```text
luxora-api@sha256:f93a22cd79d40209bd964e8a9693a9abb145301b37f0431396bed62a9db53ec5
```

No backup directory, restore destination, rehearsal container, rehearsal
volume or listener was created in this blocked stage. The candidate was not
started and no migration was applied to live. After the read-only inspection:

- live remained healthy on `127.0.0.1:8080`;
- the OTP console remained healthy on `127.0.0.1:8081`;
- the running-container inventory was unchanged;
- `luxora_phone_live_data` remained mounted only as before by the live API,
  plus the short-lived read-only inspection mount which was automatically
  removed.

## Required decision to unblock

Authorize a controlled maintenance window that permits writes to stop and the
existing live container to exit cleanly. The safe sequence is then:

1. verify the API exited and port `8080` has no listener;
2. capture the complete stopped `/app/data` tree, including the consistent
   SQLite/WAL state, blobs and uploads, into a guarded temporary source;
3. run the supported offline backup script into a new
   `pre-sync-invalidation-*` destination and verify its sealed manifest;
4. restore it into a new disposable destination;
5. start the exact `f93a…` candidate against only that disposable restore on an
   automatically allocated loopback port;
6. prove migration `024`, health/readiness, integrity/FK, reconciled data counts
   and a minimal authenticated journey;
7. remove only rehearsal resources and restart the unchanged original live
   container, unless a separately authorized promotion is later approved.

Until that maintenance authority exists, creating a file called a fresh
recoverable backup would overstate the evidence and weaken rollback safety.
