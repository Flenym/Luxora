# Luxora media/storage adversarial audit — Beta-0.1

Owner: Flenym  
Checkpoint: 2026-08-03  
Scope: current server-readable upload, attachment, local/S3 storage, file search and attachment-forwarding foundation.

## Outcome

The audited foundation now fails closed on the tested object-format, authorization,
range, stream-length and completion-race boundaries. Attachment access is never
granted by an opaque UUID alone. A current attachment owner retains access; a
message-derived Direct grant requires current membership plus an accepted,
either-direction-unblocked relationship; group/channel grants remain scoped to
current membership.

This checkpoint does **not** claim E2EE, malware safety, verified media metadata,
safe transcoding, production-cloud S3 IAM/KMS policy, CDN correctness or complete
retention and deletion propagation. Every returned attachment remains honestly marked
`unscanned`; client metadata remains `client_declared`; downloads remain forced
attachments with `private, no-store`.

## Remediated findings

Severity describes the pre-remediation boundary.

| Severity | Finding | Remediation and evidence |
| --- | --- | --- |
| High | Direct membership alone continued to grant old attachment download/file-search access after either participant blocked the other and the accepted relationship was removed. | One shared SQL predicate now requires a current accepted and unblocked Direct relationship. Both block directions, unblock-without-reaccept, owner access and group non-regression are exercised through HTTP. |
| High | A participant whose Direct media grant had been revoked could forward the old attachment into another chat and recreate access. | Every forwarded attachment is authorized before and again inside an immediate writer transaction. Mixed accessible+revoked input fails as one generic operation with no message/event; text-only historical forwarding policy is unchanged. |
| High | Corrupting the encrypted local-blob magic could make the reader fall back to legacy plaintext behavior. | When an active encryption key is configured, missing/invalid encrypted format is rejected. Header, key ID, logical size, physical size and selected GCM blocks fail closed. |
| Medium | Early attachment `404`/`416` responses were created before the successful-download cache headers and could be negatively cached. | Non-sensitive `private, no-store`, `nosniff` and `Accept-Ranges` invariants are installed before authentication. Size, MIME, disposition, ETag, total range and safety state are still emitted only after authorization. |
| Medium | The storage adapter trusted caller size/hash and S3 response headers more than necessary. | Local writes verify exact byte count and SHA-256 before atomic publication. Local reads validate exact physical layout and direct ranges. S3 reads validate exact canonical range/header metadata and actual streamed length; rejected/aborted response and request bodies are disposed. |
| Medium | Local blob/chunk rename and deletion lacked directory durability synchronization. | File data is synced before rename, and containing directories are synced for atomic publication/deletion. A failed publication leaves no committed DB attachment and deterministic cleanup remains retryable. |
| Medium | Filename validation blocked paths and ASCII controls but allowed bidi-control extension spoofing. | Path separators, controls, malformed Unicode and bidi override/isolate characters are rejected before persistence or `Content-Disposition`. |
| Medium | Request logs could contain concrete attachment/upload/message UUID path segments and could accept an attacker-supplied correlation ID. | Fixed by the API hardening workstream: successful requests are logged using matched route templates, unmatched paths are not copied, and correlation IDs are server-generated. Dedicated canary tests cover query/path/credential/content leakage while preserving method, status and duration telemetry. |
| Low | One transient S3 readiness failure was negatively cached for ten minutes. | Negative readiness cache is bounded to ten seconds; success remains cached for thirty seconds and concurrent probes remain coalesced. |

Denied existing and nonexistent attachment IDs return the same generic
`Attachment not found` response. Range totals and object metadata are not exposed
before authorization.

## Focused verification

Run with the repository's Node 22 toolchain available on `PATH`:

```bash
npm --prefix services/api test -- --run \
  src/media-security.integration.test.ts \
  src/media.integration.test.ts \
  src/storage.test.ts \
  src/storage-s3.test.ts
npm --prefix services/api run typecheck
npm --prefix services/api run build
npm --prefix services/api audit --audit-level=high
```

Checkpoint result: the four focused files passed all 22 tests; the complete API
suite passed all 70 tests across 21 files. API source/test typecheck, production
build, the repository truth guard and the high-severity dependency audit also
passed; the dependency audit reported zero vulnerabilities.

The focused suites cover:

- upload-session/chunk/completion IDOR and generic attachment denial;
- filename traversal, header injection, malformed Unicode and bidi controls;
- malformed chunk index/offset/total/digest/range and duplicate accounting;
- restart resume plus duplicate-vs-completion serialization;
- quota reservation release after deterministic MIME failure;
- MIME declaration versus detected magic and honest generic declaration handling;
- full, open-ended, suffix, clamped, multiple and unsafe-integer ranges;
- both Direct block directions, unblock without implicit reaccept, owner/group grants;
- mixed accessible+revoked forward atomicity and absence of destination event/message;
- encrypted local cross-block ranges, header/ciphertext/length tamper rejection,
  source hash, path confinement and invalid direct ranges;
- hermetic S3 encryption confirmation, exact `Content-Range`, response byte count,
  body disposal, deterministic canary cleanup and bounded readiness retry.

### Reproducible live S3-compatible checkpoint

Run:

```bash
make s3-live-gate
```

The 2026-08-03 checkpoint passed on Docker 29.6.2 `linux/arm64`. It built the
current production API image and used the following multi-platform digest pins:

- MinIO server `sha256:13582eff79c6605a2d315bdd0e70164142ea7e98fc8411e9e10d089502a6d883`;
- MinIO client `sha256:95b5f3f7969a5c5a9f3a700ba72d5c84172819e13385aaf916e237cf111ab868`.

The private versioned bucket accepted the distinct prefix-scoped service
identity and rejected credential-free GET plus cross-prefix PUT/DELETE. The real
`S3StorageProvider` passed readiness, SSE-S3-confirmed PUT/full GET/Range GET,
DELETE and current-key absence. The fault proxy dropped one response only after
MinIO committed its PUT; the provider issued one cleanup DELETE and the current
key was absent. Seven synthetic version/delete-marker records demonstrated that
normal and ambiguous deletes retained noncurrent bytes before lifecycle/admin
purge. Exported lifecycle configuration covered current expiry, noncurrent
expiry and expired delete markers. The gate then permanently removed all bucket
versions, bucket, user, policy, container, volume and network and confirmed every
named Docker resource absent.

## Open gates and residual risk

1. The local gate proves S3-compatible private behavior, a non-admin
   prefix-scoped identity, static-key SSE-S3 response/round-trip confirmation,
   lifecycle **configuration**, version residue and committed-PUT ambiguity
   cleanup. It does not prove the selected cloud's account-level public-access
   block, workload federation/IAM, managed KMS key policy/rotation/audit, TLS,
   lifecycle scanner completion, cost or deletion propagation. A versioned
   `DeleteObject` hides the current key with a delete marker; noncurrent bytes
   remain until asynchronous lifecycle or a privileged version-ID purge succeeds.
2. There is no polyglot/zip-bomb/parser corpus and no malware quarantine,
   sandboxed probe/transcode or derivative worker. `unscanned` files must never be
   presented as safe.
3. Width, height, duration and waveform remain client-declared. EXIF/location is
   not extracted or stripped, and thumbnails/transcodes are absent.
4. The current Cloud server processes plaintext before storage encryption. Local
   AES-GCM and S3 SSE are at-rest controls, not E2EE or zero knowledge.
5. Never-linked orphan cleanup exists, but complete linked-content retention,
   account deletion, versioned-object deletion, cache/CDN and backup propagation
   are not implemented.
6. S3 currently uses server-proxied single-object publication. Direct short-lived,
   object-scoped multipart credentials and production object workers remain a
   later measured architecture gate.
7. Development may intentionally run plaintext local blobs without an active
   key; the production configuration gate requires an active keyring. Moving
   legacy plaintext data into an encrypted environment requires an explicit,
   verified migration rather than a silent read fallback.
8. Local object keys are lexically confined, but the configured storage volume
   and its parent directories are still an operational trust boundary. A
   production deployment must prove service ownership/permissions and reject
   pre-existing symlinked path components.
