# Luxora Security

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Security status:** controlled Cloud preview; not approved for sensitive or production use

## 1. Current claim

> Connections must be protected in transit in shared deployments. Beta-0.1 is **not end-to-end encrypted**: the application processes message plaintext. Optional/required-at-production AES-GCM storage envelopes do not change that trust boundary.

Do not use “only members can read”, “zero knowledge”, “anonymous”, “military-grade”, an unqualified shield/lock, or E2EE/call-security copy for this build. There is no independently audited E2EE or calling implementation.

## 2. Implemented controls vs missing evidence

| Area | Implemented foundation | Still required before production claim |
| --- | --- | --- |
| Passwords | Argon2id 64 MiB / 3 iterations / p=1 | breached-password policy, full abuse/risk evidence |
| Access | HS256 allowlist, issuer/audience/expiry/session claims | asymmetric rotation design, emergency drill |
| Refresh | 256-bit opaque, hash-only, writer-reserved rotate-on-use, strict race/reuse revoke, expiry/rollback tests | production-DB fault injection, family alerts and recovery UX |
| Sessions | per-device list/revoke, realtime disconnect | richer trusted-device metadata and compromise flow |
| Phone authentication | Default-off, provider-gated OTP with normalized E.164, purpose-separated keyed digests/fingerprints, durable per-phone cooldown, bounded attempts/expiry, anti-enumeration branch after correct proof, context-bound encrypted PII/receipts and atomic phone/session registration | Real SMS adapter and vendor operations, optional post-OTP 2FA, reviewed legacy-account binding/recovery, avatar/profile binding, retention/change-number/deletion, distributed abuse controls and production provider evidence |
| Passkeys | Internal add/login/signup foundations plus default-off internal authenticator-management composition: exact RP/origin/UP/UV, encrypted intents/secrets/credentials/labels, maintained verifier `13.3.2`, purpose-separated one-time add/revoke authority, atomic account/session commits, terminal revoke with attributed-session invalidation, last-active protection and bounded exact replay | Public signup/login/management composition, independent security notifications, recovery, distributed secret storage/session fan-out, cross-platform interoperability, abuse/operations evidence and production enablement |
| Authorization | membership/author/admin plus tested IA-1 request/block/report and audience boundaries | remaining full resource/action/role matrix and member mutation tests |
| Input | strict Zod, body/page/message/member bounds | fuzz/DAST corpus and proxy-stack review |
| HTTP/WS | Helmet, exact CORS/Origin, explicit trusted-proxy CIDRs, canonical IPv4/IPv6 HTTP+WS buckets, network baseline plus local IA account/device-session buckets, auth deadline, frame/typing/auth/pending/session/backpressure bounds and local hostile tests | CSP and real-ingress/direct-bypass validation, NAT-aware risk policy, shared risk/anomaly/reconnect state and hostile distributed load |
| Logs/errors | query-free request path/method plus request ID/status/duration, excluded headers/body, generic 500, local canary | canary proof across proxy/DB/traces/crash tooling |
| Storage | production requires AES-256-GCM keyring for message bodies, immutable request fingerprints, events, requests, block/report private payloads; identity audit is DB append-only | KMS/IAM/rotation/backup evidence; relationship metadata remains readable |
| Realtime durability | domain mutation, audience event and SQLite outbox commit atomically; owner leases, restart recovery, capped retry/backoff and durable failed rows; cursor replay remains authoritative | cross-process broker/fan-out, dead-letter alert/runbook and reconnect/load evidence |
| Messaging concurrency | writer-reserved nonce/revision/receipt mutations, authoritative rehydration, strict aggregate timestamps and deterministic independent-connection races | selected production-DB pool/replica/failover tests plus randomized schedule/property evidence |
| Object storage | disposable real-provider gate proves private MinIO behavior, prefix-scoped service access, static-key SSE-S3 response confirmation, version/delete-marker semantics and committed-PUT ambiguity cleanup | selected cloud public-access-block, workload IAM, managed KMS key policy/rotation/audit and observed lifecycle/deletion propagation |
| Supply chain | lockfiles, digest-pinned CI actions and container bases, dependency review, CodeQL, Trivy, non-root shell-free/package-manager-free distroless API runtime | SBOM/signing/provenance, scheduled base-digest refresh and remediation SLA |

## 3. Assets and trust boundaries

Highest-risk secrets: passwords during verification, OTP values, raw phone-registration/refresh tokens, JWT and phone-auth HMAC secrets, data-encryption keys, future device/private keys, backup recovery secrets and release-signing keys.

Sensitive content/metadata: message plaintext, drafts, attachments, membership/social graph, presence, search queries, device/IP/push identifiers and reports.

Current flow:

`client plaintext → TLS ingress → Fastify plaintext → AES-GCM envelope (configured storage) → Fastify plaintext → client`

TLS and disk encryption reduce network/media theft risk. They do not protect against compromised application process, authorized high-privilege operator or malicious client endpoint.

## 4. Secret management

- Never commit `.env`, keys, tokens, certificates or signing material.
- `JWT_SECRET` must be random, at least 32 characters and unique per environment.
- Production requires `DATA_ENCRYPTION_KEYS` and `ACTIVE_DATA_ENCRYPTION_KEY_ID`.
- Phone authentication requires an independent `PHONE_AUTH_HMAC_SECRET`; it must not reuse JWT, data-encryption or passkey authorization/refresh material.
- Keep old data keys available during rotation until all relevant envelopes are re-encrypted/expired and backups follow policy.
- Inject secrets from a managed secret store using short-lived workload identity; do not bake them into image, Compose, CI variables visible to forks or logs.
- Separate application decrypt permission from KMS administration; audit every key-use policy change.
- Emergency rotation must revoke sessions/credentials where required and include backward-readable data migration.

The root `.env.example` contains placeholders only. The local Compose stack is not a production secret-delivery solution.

## 5. Authentication/session rules

- Password managers and paste are supported; never log credential fields.
- Generic login failure prevents simple account discovery.
- Access JWT stays short-lived; refresh token is single-use and stored only in an OS credential store/secure HttpOnly design.
- Never put bearer/refresh tokens in URL, query, analytics or crash report.
- A client serializes refresh. A serialized same-token race produces no second lineage: at most one rotation response is created, then the reuse loser revokes the entire session, including the apparent winner. Commit ambiguity is authoritatively reread and fails closed when consumption is visible; uncommitted SQLite lock exhaustion is a generic retryable `503`. Reuse is treated as compromise: erase the family and require sign-in/recovery.
- Device revoke must invalidate refresh and guarded HTTP immediately and invoke live-socket termination after commit. Cross-process fan-out and prompt-revoke latency require measured production evidence; a local transport-cleanup exception must not rewrite a durable revoke as `500`.
- Phone authentication is disabled by default. Enabling it requires an active data key and a provider: the fixed-code development provider is forbidden in production, while `external` startup fails without an injected implementation. Neither mode logs nor echoes OTP credentials, and `features.phoneAuthentication` represents effective composition rather than configuration intent.
- A begin command is idempotent by exact nonce/input, and its challenge ID is the provider idempotency key. A writer-transaction predicate enforces cooldown by keyed normalized-phone digest across changed nonces and independent writers. Code checks are attempt/expiry bounded and constant-time; identity lookup occurs only after correct proof, then yields either an existing-account `authenticated` response or a new-account `profile_required` token without a pre-proof account-existence oracle.
- Phone PII, pending delivery material, device snapshots and successful replay responses use resource-bound AES-GCM envelopes. Phone/code/token equality uses independent HMAC domains. Exact immutable receipts recover committed responses after loss; registration re-encrypts the verified number from challenge AAD to stable identity AAD. Username suggestions are advisory and unreserved; final case-insensitive username and phone uniqueness are decided atomically with the password-disabled account/session projection.
- This slice is not proof of production phone authentication: real SMS integration/monitoring, post-OTP secret-password 2FA, safe legacy-account phone binding/recovery, avatar/profile-upload binding, retention/change-number/deletion and shared multi-replica abuse/rate-limit controls remain open.
- Passkeys are not a public authentication feature. The authenticated add-authenticator seam remains internal and requires an already-bound discoverable credential for transaction-bound step-up. Identifier-free login has an internal gated service/route foundation. First-passkey signup has a strict transport/service, signed pre-account authorization, maintained-verifier and atomic SQLite account/session boundaries behind its own default-off flag. Default-off internal management routes can safely list/rename/revoke durable authenticator metadata. Revoke consumes target/revision-bound WebAuthn authority once, terminally removes verifier eligibility and atomically revokes known originating sessions/refresh rows; password-disabled accounts retain one active factor. Production categorically rejects the routed flags, management paths stay absent by default, and `GET /v1/capabilities` stays `features.passkeys:false`.
- Signup begin does not query username or credential availability. A server-owned candidate UUID, encrypted 32-byte handle and encrypted identity snapshot are persisted with an empty exclusion set; global username/credential uniqueness is resolved only in the verified immediate transaction. The signup authorization uses issuer/audience/subject/token-use and HKDF domains distinct from primary login, and authenticates intent/revision/candidate/challenge/policy/delivery/device/expiry before token-derived durable lookup. Store projections exclude raw bearer values and raw WebAuthn JSON; a per-account random discarded secret leaves only a valid Argon2id password placeholder with password authentication explicitly disabled.
- The signup-expiry reconciler selects no candidate identity/handle fields from the Store record and never places them in ownership proofs. Intent ID/revision/expiry produce deterministic command scope and fingerprint; immediate writer-time/revision CAS prevents early or double terminal transitions, and exact receipt reconciliation handles restart/second-owner ambiguity. The same transaction deletes the encrypted challenge. Backoff is capped and restricted to explicit SQLite `BUSY`/`LOCKED` codes. Startup/periodic cleanup runs even with routes disabled, its timer closes with the app, and none of this makes signup public.
- QR linking and recovery are not implemented. Public passkey signup/signin and authenticator-management HTTP/UX still require their separate origin, account/session, distributed abuse, independent notification, operations and interoperability gates; the durable management foundation is not availability evidence.

## 6. Authorization and data isolation

Opaque UUIDs are not authorization. Every fetch/mutation/event/file checks the principal and effective membership at use time. Actor/owner/trust class are server-owned. Test each endpoint with owner/member/non-member/removed/other-account principals and both guessed and previously authorized IDs.

Realtime cursor, queue and replay are bound to an authenticated user/session. Cursor MACs require one canonical encoding and expire exactly at their advertised boundary. Session state is rechecked before authenticated commands and live/queued dispatch; an unavailable status store closes the socket rather than allowing delivery. A durable event is audience-specific. Its domain mutation, encrypted event row and outbox row share one SQLite transaction; the outbox acknowledges only after process-local hub publication and deliberately retries at least once after ambiguous publish/ack crashes. Repeatedly unreadable/unpublished rows are retained as failed records instead of silently dropped. This is not a cross-process broker or a client-delivery acknowledgement. IA-1 enforces accepted-relationship and either-direction block policy for exact discovery, direct creation/mutations, presence, typing and receipts. Dismissal/block/report directions are deliberately absent from the other party’s events, and group reaction aggregates are reprojected at dispatch so an allowed actor's stored event cannot carry a now-blocked actor's state. Shared-group message content remains governed by membership and requires a client hide/rendering policy; this is not E2EE.

## 7. Web/client requirements

- Web: strong CSP, no unsafe HTML, strict frame/referrer/permissions policies, access token in memory and no long-lived refresh in `localStorage`; clear caches/service workers on logout.
- Apple: refresh/session secret in Keychain; local message/outbox database protected with OS data protection; debug logs redacted.
- Android: Keystore-backed credential wrapping/Encrypted storage as reviewed; backup disabled or explicitly encrypted; no cleartext traffic.
- Desktop: context isolation, sandbox, no Node integration, navigation/external-host allowlist, OS credential vault and signed anti-rollback updater before distribution.
- All: redact diagnostic bundles, validate deep links, minimize notification plaintext, no secret clipboard convenience.

The Apple thin harness already uses Keychain and real HTTP/WebSocket, but currently stores the access token alongside refresh credentials and has no durable offline database/reconciliation. Android/Web/Desktop remain demo/shell foundations. None yet satisfies the complete connected-client storage/auth/security gate.

## 8. Logging and telemetry

Never log password, OTP, phone-registration/access/refresh/step-up token, full phone number, JWT/HMAC/data/E2EE key, WebAuthn challenge/assertion/attestation/credential material, backup secret, message/media/draft plaintext, notification preview, exact private search query, signed object URL or full low-necessity PII.

API access logs use matched route templates rather than concrete object-ID paths,
drop query values entirely and generate correlation IDs server-side. Unmatched
client paths and supplied `x-request-id` values are not copied into logs.

The current API request serializer records only method and path without the query string; response completion retains request ID, status and duration. It does not serialize headers or request/response bodies. This is application-process coverage only, not proof about ingress, database, tracing or crash pipelines.

Allowed operational event: time, service/build, coarse environment/region, request/event class, public error category, latency bucket and short-retention rotating pseudonymous correlation. No stable raw user/chat label in Prometheus.

Before a shared deployment, inject canary credentials/content, execute success/failure flows and scan application, ingress, DB slow logs, metrics, traces and crash reports. Zero leaks is a gate.

## 9. Dependency and CI security

Current workflows run dependency review, CodeQL for JavaScript/TypeScript, Trivy filesystem/image scans and deterministic package installs. Required maturity work:

- keep pinned third-party action/image digests on a reviewed update cadence;
- generate SBOM and license report;
- sign/attest container and client artifacts;
- isolate untrusted PR jobs from secrets/signing;
- establish Critical/High remediation and exception expiry;
- add native Kotlin/Swift SAST and artifact scans;
- protect branches and sensitive paths with mandatory review.

The API build keeps npm only in its builder and copies production dependencies
into a digest-pinned Debian 13 distroless Node 22 runtime. The runtime uses UID
and GID `65532` and has no shell, npm or Corepack. On 4 August 2026, the exact
locally built runtime image passed the cached Trivy 0.73 High/Critical
vulnerability and secret scan with `0` findings in each category, then passed a
development-provider phone registration, exact registration replay and
authorized `/v1/me` smoke under read-only/rootless hardening. This is
point-in-time local evidence, not a substitute for scanning the image again in
CI and at deployment.

## 10. E2EE gate (not implemented)

Luxora will not create a custom cipher/protocol. Before the first `Private`/E2EE UI claim, all of these must pass:

1. Versioned 1:1/group/multi-device protocol profile using maintained externally reviewed libraries.
2. Per-device local identity generation/storage/link/revoke/reset semantics.
3. Forward secrecy and post-compromise security; authenticated membership epoch changes.
4. Verification plus key-transparency consistency/split-view detection.
5. Cross-platform vectors/interoperability and loss/reorder/rollback/downgrade fuzz/property tests.
6. Local Private search; no hidden plaintext via push, previews, thumbnails, transcript/AI/report/backup.
7. Independent design and implementation audit with no unresolved Critical/High.
8. Kill switch and rollback that pauses unsafe sends rather than silently falling back to plaintext.

Calls have a separate gate: signaling race tests, short-lived TURN credentials, SFU without media keys, rekey on membership changes, verification UI and screen-capture lifecycle evidence.

## 11. Vulnerability reporting

Until a dedicated private security contact/process is published, do not open a public issue containing exploit details, credentials or user data. Provide Flenym a minimal private report containing affected build/commit, reproducible steps, impact, proof using synthetic data and safe contact method. Do not test against systems/accounts you do not own or exceed authorized scope.

Repository maintainers should acknowledge, triage severity, preserve evidence, issue an incident ID, coordinate a fix/retest and publish an advisory when user action is required.

## 12. Incident and release blockers

Automatic HOLD/rollback triggers:

- cross-account content/metadata access;
- credential/key/plaintext log or artifact leak;
- refresh/session authorization bypass;
- false E2EE/secure-call state;
- acknowledged durable message loss or uncontrolled duplication;
- malicious/unverifiable release artifact;
- open Critical, or High in auth/authorization/privacy/data loss/update path.

Response order: contain → preserve evidence → revoke/rotate/disable affected capability → assess scope → notify owners/users as policy/law requires → remediate and independently retest → restore gradually → write blameless review and update threat model/tests.

The canonical, more extensive analysis is [docs/specs/THREAT_MODEL.md](docs/specs/THREAT_MODEL.md); binding evidence gates are [docs/specs/RELEASE_QUALITY_GATES.md](docs/specs/RELEASE_QUALITY_GATES.md).
