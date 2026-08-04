# Luxora disposable operations gates

**Release:** Beta-0.1  
**Owner and developer:** Flenym

These scripts provide a reproducible recovery check for the current stopped,
single-node SQLite service using `STORAGE_DRIVER=local`. They are not production
backup automation.

The same directory also contains the disposable production-image log and
at-rest canary gate:

```bash
make api-log-canary
```

It creates two synthetic accounts and one encrypted message request, verifies
that request logs exclude query values, credentials, tokens and content, then
stops the API and checks the SQLite/WAL files for raw canaries. The gate validates
the container's non-root/read-only/capability-free/loopback boundary and removes
only its uniquely named container and volume. It does not cover an external log
shipper, data warehouse, crash reporter or production deployment pipeline.

## Live S3-compatible provider gate

Run the production adapter against a disposable real object store:

```bash
make s3-live-gate
```

The Make target first builds `luxora-api:beta-0.1` from the current tree. The
gate then pulls these immutable multi-platform references and reports the
resolved runtime architecture:

- `minio/minio:RELEASE.2025-09-07T16-13-09Z-cpuv1@sha256:13582eff79c6605a2d315bdd0e70164142ea7e98fc8411e9e10d089502a6d883`
- `minio/mc:RELEASE.2025-08-13T08-35-41Z-cpuv1@sha256:95b5f3f7969a5c5a9f3a700ba72d5c84172819e13385aaf916e237cf111ab868`

MinIO has a read-only root filesystem, no Linux capabilities, no new
privileges, no host port and only an internal Docker network. Its data is in one
uniquely named synthetic volume; the two host binds are limited to the generated
policy file and the checked-in provider runner. Bootstrap credentials, service
credentials and the static SSE test key are generated independently for every
run and disappear with the synthetic resources. The bootstrap admin only creates
and later destroys the bucket controls and service identity. The API runner gets
the distinct service identity, with bucket metadata access required by the
provider readiness probe and object operations limited to `attachments/*`.

The blocking assertions are:

- explicit private anonymous policy and credential-free object GET returning
  `403`;
- enabled versioning, SSE-S3 bucket encryption and exported lifecycle rules for
  current objects, noncurrent versions and expired delete markers;
- the built production `S3StorageProvider` passes readiness, PUT, exact full GET,
  byte Range GET and DELETE/current-key `404`, with SSE-S3 confirmed by its write
  and read responses;
- PUT and DELETE outside `attachments/*` return `AccessDenied` and create no
  object version;
- a local proxy lets MinIO commit a PUT and then drops the response. The provider
  must report failure, issue its cleanup DELETE and leave the current key absent;
- version listing must still show both stored data versions and delete markers
  for normal and ambiguous deletes before cleanup;
- all versions, bucket, service user, policy, container, volume and network are
  permanently removed by exact validated synthetic names and then confirmed
  absent. The failure trap targets the same bounded resources.

The lifecycle values are disposable gate fixtures, not production retention
policy. Lifecycle configuration is proved, but the asynchronous scanner is not
waited out. A simple `DeleteObject` in a versioned bucket creates a delete marker:
the current key reads as missing while prior bytes remain as noncurrent versions
until lifecycle or a version-ID purge removes them. See the official
[AWS `DeleteObject` semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)
and [MinIO lifecycle CLI](https://docs.min.io/aistor/reference/cli/mc-ilm-rule/mc-ilm-rule-add/).

MinIO's static key setting is documented for testing/evaluation, so this drill's
SSE-S3 response and round-trip proof is deliberately not a claim about a managed
KMS, key rotation, cloud IAM, cloud public-access-block, audit trail, TLS or
production lifecycle completion. Those require evidence in the selected cloud
account. See MinIO's official
[server-side encryption settings](https://docs.min.io/aistor/reference/aistor-server/settings/server-side-encryption/).

## Local preview backup/restore policy

- Stop the API and independently verify it is stopped before backup. The script
  requires `--confirm-api-stopped` and rejects an open database when `lsof` is
  available, but it cannot create a cross-process maintenance mode by itself.
- SQLite is captured with its backup API into a standalone database, including
  committed WAL state. Do not copy only the live `.db` file.
- Durable blobs and upload staging for resumable in-flight uploads are copied in
  the same offline window. Missing active blob/chunk references fail the drill.
- Source and archive trees may contain only regular files/directories with the
  application-safe filename set; symbolic links and special files are rejected.
- The sealed archive uses 0700 directories, 0600 files, a SHA-256/size manifest,
  migration inventory, SQLite integrity checks and local object reconciliation.
- The manifest detects accidental or post-seal byte changes; it is not signed or
  keyed and therefore does not establish provenance against a malicious writer.
- Runtime secrets and encryption keys are deliberately not copied. Restoring
  encrypted content requires the compatible external keyring.
- Restore is allowed only into a new, non-existing destination.

## Commands

Use absolute paths. For a direct local process with the default data layout:

```bash
# Stop the API first and verify no writer remains.
install -d -m 0700 "$(pwd)/backups" "$(pwd)/backups/restores"

infra/operations/backup-local-preview.sh \
  --database "$(pwd)/data/luxora.db" \
  --blobs "$(pwd)/data/blobs" \
  --uploads "$(pwd)/data/uploads" \
  --destination "$(pwd)/backups/luxora-UTC-UNIQUE" \
  --confirm-api-stopped

infra/operations/verify-local-backup.sh \
  --backup "$(pwd)/backups/luxora-UTC-UNIQUE"

infra/operations/restore-local-preview.sh \
  --backup "$(pwd)/backups/luxora-UTC-UNIQUE" \
  --destination "$(pwd)/backups/restores/luxora-UTC-UNIQUE"
```

The parent directory of each new destination must already exist. For a Compose
named volume, first stop the API and operate from a locked-down helper container
or host mount with explicit resolved paths; do not guess Docker volume paths.

Run the disposable synthetic drill:

```bash
make backup-restore-test
```

Record a real controlled-preview exercise with
[BACKUP_RESTORE_EVIDENCE_TEMPLATE.md](BACKUP_RESTORE_EVIDENCE_TEMPLATE.md).
Database and deployment limits remain canonical in
[DATABASE.md](../../DATABASE.md), [DEPLOY.md](../../DEPLOY.md), and
[TESTING.md](../../TESTING.md).

## Residual gates

Online backup coordination, archive encryption and managed key separation,
manifest signing/attestation, retention/deletion, off-host replication, target
object-store reconciliation, point-in-time recovery and measured RPO/RTO/DR game
days remain unimplemented production gates.
