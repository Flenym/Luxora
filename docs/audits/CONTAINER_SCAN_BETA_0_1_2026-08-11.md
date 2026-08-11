# Luxora Beta-0.1 — final local API container evidence

**Date:** 11 August 2026
**Owner/developer:** Flenym
**Scanner:** Trivy 0.73.0; the final invocation downloaded its vulnerability
database normally and did not reuse a reported result from an earlier image

## Final candidate artifact

- Tag: `luxora-api:chat-folders-final-candidate-20260811`.
- OCI repo digest/image ID:
  `sha256:a76701b1a37610bd9bcf31c41d668645a983744bf256e47fbef9726c6af2ba5b`.
- Size: `90,376,562` bytes (`86.19 MiB`); platform: `linux/arm64`.
- The final artifact came from an explicit no-cache rebuild after the last
  SQLite purge-plan change. Earlier `c293…` and `3bd…` builds were treated as
  stale and were not used for the scan or smoke evidence below.
- Runtime: digest-pinned Debian 13 distroless Node 22 base
  `sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167`,
  Node `v22.23.2`, numeric configured and observed UID/GID `65532:65532`.
  Runtime probes confirmed that `/bin/sh`, `/usr/bin/bash` and `apt` are absent.

## Final Trivy gate

The final tag above was scanned through Docker socket inspection with vulnerability
and secret scanners, filtered to the release-blocking severities. The JSON result
contained:

- Critical vulnerabilities: **0**
- High vulnerabilities: **0**
- Secret findings: **0**

The effective gate was:

```text
trivy image --scanners vuln,secret --severity HIGH,CRITICAL
  luxora-api:chat-folders-final-candidate-20260811
```

No candidate secret values were printed by the JSON summarizer.

## Isolated authenticated smoke

The exact digest above ran in a new disposable container and volume, bound only
to `127.0.0.1:18085`. The container used a read-only root filesystem, `cap_drop=ALL`,
`no-new-privileges`, and a mode-`0600` temporary env file containing newly generated,
independent JWT and AES material whose values were never printed.

Observed checks:

- `/health/live`: HTTP `200`, `status=ok`, release `Beta-0.1`;
- `/health/ready`: HTTP `200`, `status=ready`, release `Beta-0.1`;
- `/v1/capabilities`: HTTP `200`, chat folders enabled,
  `maxChatFolderActiveCommandReceipts=64` and
  `chatFolderIdempotencyTtlSeconds=86400`;
- password registration: HTTP `201`;
- first folder create: HTTP `201`, state revision `1`;
- semantically canonical replay using the same nonce and reordered
  `includeKinds`: HTTP `201`, the identical folder and state revision, and
  `replayed=true`;
- second folder create: HTTP `201`, state revision `2`;
- reorder with `expectedStateRevision=2`: HTTP `200`, state revision `3`;
- a second reorder still using stale `expectedStateRevision=2`: HTTP `409`,
  `CONFLICT`;
- final folder list: HTTP `200`, two folders in the committed order with state
  revision `3`;
- authenticated `/v2/sync/snapshot`: HTTP `200`, exactly 12 unique reset
  collections, including `chat_folders`, with
  `resources.chatFolders=/v1/chat-folders`.

The running candidate's SQLite database was then inspected through a second
read-only connection:

- 23 applied migrations; latest
  `023_chat_folder_receipt_retention`;
- `PRAGMA integrity_check`: `ok`;
- `PRAGMA foreign_key_check`: zero rows;
- journal mode: `wal`;
- smoke aggregate: folder state revision `3`, two folders and three committed
  idempotency receipts.

Cleanup was verified after evidence capture: the disposable container count,
volume count, temporary env-file count and port-`18085` user count were all zero.
The final candidate image itself remains available under the tag and digest above.

## Live boundary and promotion status

This checkpoint did **not** modify the live API, its port `8080`, or its data
volume. Live therefore remains on the previously deployed migration `021`
artifact; migration `023` exists only in the unpromoted final candidate evidence.
Promotion remains pending the real iPhone authenticated reconciliation checkpoint
that accepts the 12-collection snapshot (including `chat_folders`) and completes
the chat-folder client merge.

## Historical lower-severity inventory — not final-candidate evidence

The earlier audit recorded 14 unfixed Debian findings for image
`sha256:c514db0ed19b68fd44766f7999217596dec2848ff1121e818f385860b580d7a6`
using that checkpoint's all-severity database: 2 Unknown, 7 Low and 5 Medium.
That all-severity inventory was **not** rerun for the final `a767…` candidate and
cannot be attributed to its newer scan database. It is retained only as historical
provenance:

- glibc Medium: `CVE-2026-5435`, `CVE-2026-5450`, `CVE-2026-5928`,
  `CVE-2026-6238`;
- zlib Medium: `CVE-2026-27171`;
- glibc Low: `CVE-2010-4756`, `CVE-2018-20796`, `CVE-2019-1010022`,
  `CVE-2019-1010023`, `CVE-2019-1010024`, `CVE-2019-1010025`,
  `CVE-2019-9192`;
- glibc Unknown: `CVE-2026-6368`, `CVE-2026-6791`.

This is point-in-time local evidence. It does not replace CI-at-commit,
registry-at-push, SBOM, signing/provenance, cloud-runtime scanning or recurring
base-image remediation gates.
