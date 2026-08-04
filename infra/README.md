# Luxora infrastructure notes

This directory contains local and reference infrastructure for **Beta-0.1**.
Owner and developer: **Flenym**.

Validate all local definitions without starting the API:

```bash
make check-truth compose-config calls-config compose-security-check prometheus-check
```

Run the disposable stopped-service SQLite + local blobs/uploads recovery drill:

```bash
make backup-restore-test
```

Run the disposable production-provider S3-compatible security/correctness gate:

```bash
make s3-live-gate
```

It uses digest-pinned MinIO on an internal network with no host ports, synthetic
runtime credentials and exact cleanup. Its local SSE-S3/IAM/versioning evidence
does not substitute for selected-cloud KMS, IAM or lifecycle execution proof.

Its exact scope and production residuals are documented in
[`operations/README.md`](operations/README.md).

`calls-config` validates only the independent SFU/TURN infrastructure probe; it
does not claim that Luxora calls or their control plane are implemented.

The root Compose stack is a single-node development/preview environment. It is
not the production topology and does not prove availability, disaster recovery,
encryption-at-rest, or scale claims. Production must use a managed secret store,
TLS ingress, isolated networks/accounts, external durable storage, tested backups,
and an audited deployment pipeline as described in `DEPLOY.md` and `SECURITY.md`.

Start only the API:

```bash
cp .env.example .env
# Replace JWT_SECRET with a locally generated value; the example is invalid.
make compose-up
```

Start the API and local Prometheus:

```bash
make compose-observability-up
```

Prometheus is exposed only on `127.0.0.1:9090`. The API is exposed only on
`127.0.0.1:${LUXORA_API_HOST_PORT:-8080}`. The API container port remains 8080.

Prometheus uses the supported 3.13 LTS distroless image pinned by multi-platform
digest. It runs as its upstream unprivileged user, has a read-only root filesystem,
and is capped to seven days or 1 GB of local TSDB data. The lifecycle/admin APIs
are not enabled. The alert rules are evaluated locally only: this stack has no
Alertmanager, paging, TLS, authentication, remote write, HA, SLO evidence, or
tested observability backup.
If `METRICS_TOKEN` is enabled, the supplied scrape will fail until credentials
are provided through a non-committed file or external secret integration.

Compose `.env` delivery and Docker-managed named volumes are local conveniences,
not production secret or storage controls. No CPU/memory capacity claim is made.
Do not copy this topology into a public environment.
