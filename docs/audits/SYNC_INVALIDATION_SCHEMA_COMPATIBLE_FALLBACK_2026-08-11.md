# Luxora Beta-0.1 — schema-compatible sync-invalidation fallback evidence

**Date:** 11 August 2026

**Owner/developer:** Flenym

**Decision:** artifacts and isolated rehearsals passed. After a separate
explicit approval, the exact primary artifact was promoted to the local live
preview; the schema-compatible fallback remains the only permitted application
fallback.

## 1. Safety boundary and backup

Artifact preparation and rehearsal did not promote, replace, restart or mount
the live API container or its data volume. Before the later explicitly
authorized maintenance window, the exact live boundary was:

- container ID
  `bff0396f4f74ae1c9b87e3ca4c981494f985c1444a39c4b2ee6903f8abb7c9e0`;
- image ID
  `sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`;
- healthy on loopback `127.0.0.1:8080`.

Before the migration rehearsal, the live service was stopped for a measured
`9.417` seconds only to make a sealed local backup, then the same container and
image were restarted. The verified backup is:

- `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-sync-invalidation-20260811T132654Z`;
- manifest SHA-256
  `8be1bfa5e20bb95e0b93a6cb7abb185f8ebcc69907d91ca0b8b979958ab61579`;
- nine files; manifest verification, SQLite integrity and foreign keys passed;
- source database latest migration: `021`.

The backup was restored into a separate disposable volume. The original
candidate upgraded only that clone to migration `024`; no migration was
applied to live data.

## 2. Why the previous images are not rollback targets

The original candidate
`sha256:f93a22cd79d40209bd964e8a9693a9abb145301b37f0431396bed62a9db53ec5`
passed its initial phone/folder/invalidation smoke, but an additional
schema-compatibility probe exposed an unsafe remove/re-add path. Its compiled
membership insert uses revision `1`; migration `024` keeps a terminal revision
ledger and requires a re-add to use `ledger.last_revision + 1`. A clone with a
removed membership therefore rejected the old-style re-add with
`chat membership insert invariant failed`.

The live `c514db0e…` build predates the same ledger-aware implementation and is
also not a valid application rollback after an `024` database has been used.
Neither image may be started against post-`024` data. Removing migration rows,
editing the ledger or restoring the old data backup while retaining later
writes are prohibited. A data restore would be a separate disaster-recovery
decision that explicitly accepts all post-backup data loss.

## 3. Schema-compatible emergency seam

The replacement keeps migration `024` and the monotonic membership-revision
implementation. `SYNC_INVALIDATION_ENABLED` is a strict runtime flag accepting
only `true`, `false`, `1` or `0`; it defaults to `true`.

When explicitly set to `false`, only `sync.invalidated` is degraded:

- new invalidations are not created by profile, avatar, attachment-cleanup or
  session-side projection mutations;
- the store rejects accidental direct `sync.invalidated` appends;
- live Hub delivery is suppressed;
- historical invalidations are filtered before the replay limit is applied;
- pending invalidation outbox records are acknowledged without delegate
  delivery, preventing an infinite retry loop;
- ordinary domain events, migrations, authentication, chat folders and
  membership mutations continue;
- `/v1/capabilities` reports `features.syncInvalidation:false`.

The primary/default path reports the capability as `true`. A response from an
older Beta-0.1 server that lacks the additive field parses conservatively as
`false`, rather than implying support or breaking response decoding.

## 4. Source and two no-cache artifacts

Both images were independently built with `--no-cache` from one frozen Docker
context containing `165` files. Its sorted path/content manifest SHA-256 is:

`d83b7c53c6a9acc19e3a81dabeb1d87173e66351d6ce4d4fa62aa00b5eaee1d7`.

| Mode/tag | linux/arm64 image ID | Runtime activation |
|---|---|---|
| historical primary tag (retired; image ID is binding) | `sha256:47e66d5d490d770d79a62708be5061519e5d04b63888e78dfd7934e63f4a046a` | unset/default or explicit `SYNC_INVALIDATION_ENABLED=true` |
| historical fallback tag (retired; image ID is binding) | `sha256:f907528e5f0d39656989e5c77cbae8cf4bcabdb97216d14de8bf3bc27063c3d0` | explicit `SYNC_INVALIDATION_ENABLED=false` |

The two OCI IDs differ because independent no-cache builds preserved different
filesystem/build timestamps. This is not source drift:

- both have `33` RootFS layers;
- base layers `0` through `22` are identical; independent runtime COPY layers
  `23` through `32` differ;
- image environment, entrypoint and command are identical;
- a distroless Node, network-disabled verifier recursively hashed sorted
  relative paths and payload bytes for `/app/data` plus protocol, passkey and
  API `package.json`, `dist` and `node_modules` trees;
- both contained exactly `10,521` entries and `113,810,425` regular-file bytes;
- both produced payload SHA-256
  `424825e941be639377446a13025443b61ff35db5cf721b20c8dd08871e38d136`;
- their metadata hashes differ, confirming the OCI difference is metadata,
  while every selected runtime path and byte is equal.

## 5. Automated verification and scans

The verified tree passed:

- API source and test typecheck;
- protocol typecheck;
- full API suite: `68` files, `606/606` tests;
- full protocol suite: `10` files, `85/85` tests;
- focused fallback replay/live/outbox tests, including more than one replay
  window of historical invalidations, V1/V2 filtering and outbox acknowledge
  without delivery.

Trivy `0.73.0` scanned both exact local images with vulnerability and secret
scanners at HIGH/CRITICAL severity. Aggregate results were identical:

| Image | High | Critical | Secrets | Targets |
|---|---:|---:|---:|---:|
| Primary | 0 | 0 | 0 | 2 |
| Fallback | 0 | 0 | 0 | 2 |

The report SHA-256 values are
`caa00931c990885e15cb9fe58b314ac984997497e853d7b795394ceddea3e575`
for primary and
`dbde3ce5e2cae9abe6127d49a602323359971acfcc5c7d4897c36e0df0745ed8`
for fallback. No finding body or secret value was printed.

## 6. Fresh primary smoke

The primary image ran with an empty named volume, read-only root filesystem,
bounded `/tmp`, `cap_drop=ALL`, `no-new-privileges` and no public listener. It
passed:

- healthy startup and `features.syncInvalidation:true`;
- phone challenge, verification, new-profile registration and `/v1/me`;
- chat-folder create and exact idempotent replay;
- the authoritative 12-collection snapshot;
- V2 live and replay delivery of a profile invalidation;
- absence of that additive invalidation on V1.

After a clean exit `0`, the database reported migration `024`, integrity `ok`,
zero foreign-key violations, two durable events and two outbox rows.

## 7. Candidate-migrated fallback rehearsal

The already-`024` candidate volume was stopped and cloned. A read-only
path/content comparison proved the source and clone equal: three files,
`1,592,831` payload bytes and SHA-256
`2c061f0b5cfda71081a9f0f356d942bef6179c34125c95acec118c3e40872485`.

The fallback image then ran only on that clone with the emergency flag
explicitly `false`. It passed:

- healthy startup and truthful capability `false`;
- two registrations and authenticated `/v1/me` reads;
- a real profile mutation with no reconciliation-head advance and no live
  `sync.invalidated` delivery;
- a chat-folder mutation whose ordinary `chat.folders.updated` event was
  delivered and whose snapshot head advanced;
- membership add, remove and re-add with exact revisions `1 → 2 → 3`;
- member visibility after the re-add.

After clean exit `0`, the clone reported migration `024`, integrity `ok`, zero
foreign-key violations, one current re-add matching `ledger + 1`, zero pending
outbox records and zero pending invalidation records.

## 8. Promotion and incident runbook

The completed promotion does not broaden the rollback choices. The only
supported paths are:

1. Use the primary artifact with the flag defaulted or explicitly set to
   `true`; verify readiness, capability `true`, authentication, snapshot,
   ordinary events and V2 invalidation before increasing traffic.
2. If and only if `sync.invalidated` is the suspected incident source, keep the
   same schema-compatible code and set the flag explicitly to `false`. Verify
   readiness, capability `false`, stable profile-mutation head, ordinary event
   delivery, outbox drain and membership remove/re-add monotonicity.
3. Never start `c514db0e…` or `f93a22cd…` on an `024` volume. Never manually
   undo migration `024` or its ledger.
4. To restore primary mode, first force/verify an authoritative client
   reconciliation snapshot, deploy the exact primary artifact with the flag
   `true`, then repeat capability, V2 invalidation, ordinary-event and outbox
   gates.
5. A sealed data restore is last-resort disaster recovery, not application
   rollback, and requires an explicit decision about post-backup data loss.

The primary and fallback rehearsal containers were stopped. Their disposable
volumes and local evidence files were retained for review. The then-current
live container remained healthy and untouched throughout both artifact
rehearsals; the separately authorized promotion is recorded below.

## 9. Authorized local-live promotion

Immediately before maintenance, read-only inspection recorded `21` applied
migrations with latest `021_push_registration_preferences`, SQLite integrity
`ok`, zero foreign-key violations and this exact baseline:

| Projection | Rows |
|---|---:|
| attachments | 2 |
| chat members | 14 |
| membership command receipts | 5 |
| chats | 11 |
| device sessions | 44 |
| messages | 10 |
| notification settings | 1 |
| push registrations | 1 |
| realtime events / outbox | 72 / 72 |
| refresh tokens | 49 |
| upload chunks / sessions | 1 / 1 |
| users | 35 |

Only `luxora-phone-live` was stopped, and the loopback `8080` listener was
confirmed closed. While the API was offline, the supported backup tool created
and verified a new sealed snapshot:

- `/Users/vikavavilina/Documents/egor/Luxora-local-backups/Beta-0.1/pre-live-m024-promotion-20260811T143400Z`;
- nine manifest files, SQLite integrity and foreign keys passed;
- `SHA256SUMS` digest
  `f0867986a23f8b03b919e3117616ee6e18d5ab7dd09b89873bb1f538778cbabc`.

The temporary raw copy used by the supported backup command was removed only
after a final successful verification. The sealed backup was retained.

The old container was not deleted. It is stopped and renamed to
`luxora-phone-live-pre-m024-20260811T143400Z`, preserving container ID
`bff0396f4f74ae1c9b87e3ca4c981494f985c1444a39c4b2ee6903f8abb7c9e0`
and old image `c514db0e…`. It must never be restarted against the now-`024`
volume.

The new live container is:

- name `luxora-phone-live`;
- container ID
  `429cd2f83b4a81c4df64eba1160897ac133a951c7743523623807c94e4dbf51d`;
- exact primary image
  `sha256:47e66d5d490d770d79a62708be5061519e5d04b63888e78dfd7934e63f4a046a`;
- explicit `SYNC_INVALIDATION_ENABLED=true`;
- the same `luxora_phone_live_data:/app/data` mount, default bridge network,
  `127.0.0.1:8080`, read-only root, numeric `65532:65532`,
  `cap_drop=ALL`, `no-new-privileges`, `json-file` logging and
  `unless-stopped` restart policy.

The readiness endpoint became healthy at `2026-08-11T14:34:12Z`. Measured
downtime from stop initiation at `14:34:00Z` was `12.005` seconds. The primary
passed directly; the fallback was not activated.

Before synthetic traffic, all baseline projections above were exactly
unchanged. The database had `24` migrations, latest
`024_chat_membership_revision_ledger`, two ledger rows, integrity `ok` and zero
foreign-key violations. Live, readiness, capability and OTP-console checks all
passed; capabilities advertised sync invalidation, realtime, reconciliation,
chat folders and preferred realtime V2.

The authenticated postdeploy smoke then passed phone challenge/verification,
new-profile registration, `/v1/me`, chat-folder create and exact replay, the
12-collection snapshot, V2 live invalidation, V2 cursor replay and V1 absence.
Its exact expected durable deltas produced the final aggregate below:

- users `36`, device sessions `45`, refresh tokens `50`;
- chat folders/state/command receipts `1/1/1`;
- realtime events/outbox `74/74`;
- all pre-existing attachment/chat/member/message/media/notification/push
  counts unchanged;
- pending outbox `0`, failed outbox `0`;
- integrity `ok`, foreign-key violations `0`, latest migration `024`.

Final live/readiness/OTP HTTP checks returned `200`; exactly one loopback
binding owned `127.0.0.1:8080`. This is a successful local-live preview
promotion, not evidence of public production readiness or multi-node disaster
recovery.
