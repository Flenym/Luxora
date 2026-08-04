# Luxora sync/realtime adversarial audit — Beta-0.1

Owner: Flenym  
Checkpoint: 2026-08-03  
Scope: current V2 signed cursor, SQLite replay, WebSocket session lifecycle and
authoritative HTTP reconciliation foundation.

## Outcome

The audited single-node foundation now rejects tested cursor alias/timing/scope
attacks, never falls back from V2 to numeric replay, rechecks session and current
authorization state before tested live/replayed delivery, and exposes canonical
snapshot resources only through authenticated, viewer-scoped, non-cacheable
responses.

This is not a production sync claim. There is a tested single-node SQLite
transactional outbox, but no cross-process fan-out, distributed retention, rolling-deploy compatibility,
membership-removal epoch, reconnect/load proof or complete client outbox.

## Remediated findings

Severity describes the pre-remediation boundary.

| Severity | Finding | Remediation and evidence |
| --- | --- | --- |
| High | A naturally expired or externally revoked session could continue receiving live durable/ephemeral state and issuing commands until the periodic heartbeat check. | Session activity is now checked before activation, every authenticated command and queued/live/ephemeral delivery. Synthetic external revocation closes with `4001` before command acknowledgement or dispatch; a status-store outage closes `1011` without throwing across a committed publisher boundary. Same-process revoke still terminates directly. |
| Medium | A permitted group reaction event stored before a later block could embed the blocked actor's reaction in its aggregate even though the blocked actor's own event was filtered. | Every reaction event is reprojected from current viewer-filtered canonical state at dispatch. The hostile replay keeps the allowed actor/receipt and proves the blocked reaction canary and receipt actor are absent. |
| Medium | Structurally corrupted and mixed numeric+cursor V2 authentication frames failed in generic parsing instead of entering the documented authoritative recovery path. | Bounded string input reaches authenticated cursor verification; the hub rejects mixed input before interpretation. Both now emit `ready(cursor=null)`, `sync.required(reason=cursor_invalid)` and close `4009` with no dispatch. Oversized/non-string frames remain parser-bounded. |
| Medium | Canonical message/pin/topic and several reconciliation error responses lacked an explicit private cache prohibition. | Sensitive route families plus every dedicated reconciliation handler now apply `Cache-Control: private, no-store` and `Pragma: no-cache` on success and denial. Owner/member/outsider tests cover canonical paths without returning object canaries in denied bodies. |
| Medium | Reaction/receipt reads returned `403` for a real foreign message but `404` for an absent UUID, exposing a cross-chat existence oracle. | Both reads now collapse absent and unauthorized message IDs to the same generic `404`; existing-vs-random tests compare public code/message and verify no content or participant IDs. |
| Low | Comparing decoded HMAC bytes accepted alternate non-canonical base64url signature spellings. | The constant-time comparison now covers the exact encoded MAC. A hostile test constructs a distinct textual signature that decodes to identical bytes and proves rejection before claims are used. |
| Low | The exact advertised cursor-expiry second remained accepted. | Expiry is now exclusive (`now >= expiresAt`), with just-before, exact and after-boundary tests. Future skew, invalid dates, negative and unsafe sequences are also bounded. |
| High | A process crash after the domain/event commit but before the direct hub call left no durable publication attempt. | Every new audience event now atomically enqueues a SQLite outbox row. An owner/lease worker publishes before acknowledgement, retries with capped backoff, recovers restart/expired claims, permits sequence-idempotent duplicates after publish-before-ack ambiguity and durably dead-letters poison rows without blocking later events. Nine focused outbox tests cover the failure model, including a producer clock one day ahead. |

## Focused verification

Run with the repository Node 22 toolchain available on `PATH`:

```bash
npm --prefix packages/protocol test -- src/index.test.ts
npm --prefix packages/protocol run typecheck
npm --prefix packages/protocol run build
npm --prefix services/api run typecheck
npm --prefix services/api test -- \
  src/realtime/cursor.test.ts \
  src/sync-reconciliation.integration.test.ts
```

Checkpoint result: protocol passed 17 tests; the focused API files passed 17
tests. Protocol and API production/test-source typechecks passed. The independent
root acceptance run passed the complete API suite: 21 files / 84 tests, followed
by a successful production build.

The focused suites cover canonical MAC encoding, exact TTL/future/unsafe-number
bounds, account and device-session binding, foreign/tampered/ahead cursors,
numeric-only and mixed V2 downgrade attempts, replay overflow, sparse global
sequences, current Direct authorization, blocked group actors/aggregates,
report/attachment IDOR and content canaries, stable pagination, active-session
rechecks, session-store failure, and private non-cacheable canonical reads.

## Open gates and residual risk

1. The single-node commit/publish crash gap now has a durable at-least-once
   outbox and reconnect replay path. Cross-process fan-out is still absent: a
   shared SQLite claim consumed by one API process does not publish to sockets
   owned by another process. A reviewed broker/fan-out design is required.
2. Same-process revocation disconnects immediately. An idle socket revoked by an
   external process is detected at the next command, dispatch or 25-second
   heartbeat; production revocation fan-out and latency SLI evidence are absent.
3. Physical event pruning, key-rotation overlap, distributed cursor verification,
   reconnect storms, slow-consumer load and rolling deploys are unproved.
4. V1 numeric replay remains compatibility-only and does not provide the V2
   account/session-bound cursor guarantee.
5. Reconciliation page cursors are bounded but not signed or resource/account
   bound. SQL ownership predicates prevent cross-account reads, but production
   robustness should authenticate page scope and reject cross-resource reuse.
6. Attachment-deletion tombstones and future membership/device/notification/
   call/push/E2EE canonical resources are absent. Those domains must not emit a
   recoverable event until they have an authoritative rebuild path.
7. Current encrypted event AAD is audience-scoped rather than sequence-scoped.
   At-rest encryption protects snapshot confidentiality and detects arbitrary
   ciphertext changes, but a production tamper-evident log/sequence-binding
   design remains a separate integrity gate.
8. V2 exposes the SQLite-global `sequence`/`headSequence`; authenticated clients
   can sample coarse aggregate event-volume changes across accounts. Production
   should move to an account-scoped logical position or hide the global head.
9. Pins are capped, but topics and per-message reaction cardinality are not yet
   bounded/paginated. Canonical rebuild can therefore grow without a fixed page
   budget; enforce server caps and cursor pagination before production load.
