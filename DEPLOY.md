# Luxora Deployment

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Статус:** local/controlled preview instructions; no production approval

## 1. Deployment truth

The repository can build and run a single API container backed by a persistent SQLite volume. This proves packaging and a limited operational loop only. It does not prove public TLS, horizontal scale, high availability, E2EE, production backup/DR, SLO or compliance.

Do not expose the root Compose stack directly to the internet. Production requires every gate in the final sections of this document plus [SECURITY.md](SECURITY.md) and `docs/specs/RELEASE_QUALITY_GATES.md`.

## 2. Supported local toolchains

- Node.js 22+ and npm for protocol/API/Web.
- Docker Engine + Compose v2 for container preview.
- Swift 6.2 / Xcode 26 for Apple foundations.
- JDK 17, Android SDK 36 and project Gradle bootstrap for Android.

CI is the canonical clean-machine check. Local success alone is not release evidence.

## 3. Local process run

```bash
npm --prefix packages/protocol ci --no-audit --no-fund
npm --prefix packages/protocol run build
npm --prefix services/api ci --no-audit --no-fund
cp services/api/.env.example services/api/.env
```

Generate a local JWT secret without writing it to shell history as a literal:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url') + '\n')"
```

Place the output in the untracked `services/api/.env`, then:

```bash
set -a
source services/api/.env
set +a
npm --prefix services/api run dev
```

Validate liveness/readiness and API metadata:

```bash
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/openapi.json >/dev/null
```

## 4. Docker build and Compose

The Dockerfile copies both protocol and API, so build context must be repository root:

```bash
docker build -f services/api/Dockerfile -t luxora-api:beta-0.1 .
```

Local Compose:

```bash
cp .env.example .env
# Replace JWT_SECRET in .env.
make compose-config
make compose-up
```

The API binds to `127.0.0.1:${PORT:-8080}`. The build stage uses the digest-pinned
Node 22 image; the shipped runtime is a separately digest-pinned Debian 13
distroless Node 22 image. It runs as numeric non-root UID/GID `65532`, contains
no shell or package manager, drops Linux capabilities, enables
`no-new-privileges`, has a read-only root filesystem and writes only `/app/data`
plus tmpfs `/tmp`.

Observability profile:

```bash
docker compose --profile observability up --build -d
```

Prometheus binds to `127.0.0.1:9090` and retains local data for seven days. The supplied scrape assumes `/metrics` is reachable only on the internal Compose network. If `METRICS_TOKEN` is enabled, configure Prometheus bearer credentials through a non-committed secret file; never place the token in `prometheus.yml`.

Stop:

```bash
docker compose down
```

Do not add `--volumes` unless deletion of local API/metrics data is explicitly intended and backed up.

## 5. Production-required environment

Production config refuses startup without:

- `JWT_SECRET` at least 32 characters, random and environment-unique;
- `DATA_ENCRYPTION_KEYS` JSON object with 32-byte base64url values;
- `ACTIVE_DATA_ENCRYPTION_KEY_ID` referencing the current key;
- exact `CORS_ORIGINS`, never `*`;
- durable writable `DATABASE_PATH` while the service remains on SQLite;
- empty `TRUSTED_PROXY_CIDRS` for direct mode, or the smallest explicit
  comma-separated IP/CIDR allowlist for actual ingress/proxy source hops;
  boolean trust-all, hop counts and catch-all `/0` ranges are forbidden.

Generate a 32-byte base64url data key out of band:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url') + '\n')"
```

Inject secrets from a managed secret store/workload identity. Do not use Compose `.env`, image `ENV`, build args, Git repository or broad CI secrets for production. Retain old decryption keys through rotation and verified re-encryption/retention windows.

## 6. Required production topology

Before any public deployment:

1. Managed TLS ingress terminates TLS 1.2+ (1.3 preferred), redirects/denies plaintext and applies HSTS.
   The API network permits only the CIDRs declared in `TRUSTED_PROXY_CIDRS`;
   there is no public/direct bypass. The public edge removes client-supplied
   `X-Forwarded-For` and writes its observed peer; any additional trusted proxy
   appends only its observed peer in a tested order.
2. API is private behind ingress; `/metrics` and preferably `/docs` are inaccessible from public network.
3. CORS and WebSocket Origin allowlists match actual HTTPS origins exactly.
4. Workload identity retrieves secrets; runtime filesystem/image contains no secret.
5. Database/object/backups/logs are encrypted with audited IAM/KMS boundaries.
6. Egress is allowlisted for only required push/media/link-preview dependencies.
7. Logs/traces are content/credential-redacted and short-retention.
8. At least two service instances are used only after storage/event design supports it; never share a SQLite file over NFS.
9. Alerts, owner/on-call, runbooks, rollback and support communication are tested.

The completed server-platform roadmap will replace the single process/SQLite topology with production data, event, media, search, push and call infrastructure based on measured ADRs.

## 7. SQLite backup baseline

SQLite is current preview storage. Copying only `.db` while writes continue is
unsafe, and database consistency alone does not make blobs/upload staging
consistent. The repository therefore implements a stopped-service local drill;
see [`infra/operations/README.md`](infra/operations/README.md).

Controlled procedure:

1. Record build/image digest and current readiness.
2. Stop writes with `docker compose stop api` and verify the container exited cleanly.
3. Resolve explicit absolute database, local blob and upload-staging paths. For a
   Compose named volume, use a locked-down helper mount; do not guess Docker's
   host-internal volume path.
4. Run `infra/operations/backup-local-preview.sh` with those three paths, a new
   destination and `--confirm-api-stopped`. The tool creates a standalone SQLite
   backup, includes local blobs/uploads, writes a SHA-256/size manifest and fails
   on integrity, migration, permission or active-object reconciliation errors.
5. Restart the original API and verify readiness.
6. Run `verify-local-backup.sh`, then `restore-local-preview.sh` into a **new**
   destination/environment. Existing destinations are rejected.
7. Configure the isolated restore with its compatible external encryption
   keyring; the archive deliberately carries no runtime secrets or keys.
8. Start the same compatible build and exercise synthetic auth, chats, messages,
   receipts, media download and realtime replay as applicable.
9. Record duration, checksums, schema IDs and outcomes with the
   [evidence template](infra/operations/BACKUP_RESTORE_EVIDENCE_TEMPLATE.md).

`make backup-restore-test` proves the disposable offline script path, manifest
tamper rejection and new-destination rule. It is not evidence for a real dataset
or production topology. Online coordination, encrypted/off-host automation,
signed provenance, retention/deletion, target object-store recovery, PITR and
measured RPO/RTO/DR game days remain blocking. A backup that has never been
restored is not evidence.

## 8. Migrations

Startup applies ordered migrations transactionally and records IDs. Current migrations are forward-only. Deployment rules:

- backup and restore-test before a destructive or non-backward-compatible change;
- expand schema first, deploy mixed-version-compatible code, backfill, then contract later;
- one release must tolerate old/new fields while rolling;
- never rewrite encrypted content without retaining old keys and checksums;
- migration failure keeps traffic off the unhealthy instance;
- rollback means compatible code rollback or reviewed forward-fix, not manual DB edits.

## 9. Observability

Current metrics cover process uptime, authenticated socket count, HTTP totals and public error totals. Supplied alerts detect scrape/API loss, 5xx ratio and internal errors.

Before production add bounded-cardinality histograms/SLIs for:

- send → durable acceptance;
- durable acceptance → online dispatch;
- reconnect/resume outcome and replay overflow;
- refresh reuse/revoke and authorization denials;
- event queue/backpressure, DB latency/busy/error and process saturation;
- media/search/push/call workers as introduced.

Every alert needs severity, owner, actionable threshold, runbook and dedup. Never add user/chat/message plaintext or stable private identifiers as metric labels.

## 10. Rollout

1. Build from reviewed commit using clean CI; retain tests, SBOM/scans and image digest.
2. Scan image and verify it runs as non-root with no credentials/debug artifacts.
3. Deploy to isolated production-like environment and run migrations/readiness/smoke/authorization tests.
4. Canary a small synthetic/internal audience; compare errors, send correctness and resource use.
5. Increase gradually only while predeclared thresholds hold.
6. Keep previous compatible image and tested kill switches available.
7. Record release decision and residual risks.

No automatic public release pipeline is enabled because signing environments, production target, secret identity and approvals are not yet defined.

## 11. Incident and rollback baseline

Immediate halt triggers: cross-account access, secret/content leak, false E2EE state, acknowledged message loss, malicious artifact, severe auth/session bypass or sustained error/saturation threshold.

Runbook:

1. Freeze rollout and identify build/config/region/dependency.
2. Preserve logs/audit with access controls; never copy message plaintext into tickets.
3. Disable affected feature or route traffic to last compatible build.
4. Rotate/revoke credentials/keys/sessions when relevant.
5. Verify schema/event compatibility before code rollback; otherwise forward-fix.
6. Re-run readiness, auth/IDOR/send/realtime smoke and canary log scan.
7. Restore gradually and communicate only verified scope.
8. Write post-incident review and add regression/threat-model evidence.

E2EE rollback may pause creation/sends or require update; it may never silently downgrade to server-readable plaintext.
