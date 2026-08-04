# Luxora passkey ceremony domain

Owner/developer: **Flenym**. Canonical release label: **Beta-0.1**.

This package is an isolated, deterministic server-domain foundation for
WebAuthn ceremony orchestration. It does **not** make passkeys available in
Luxora and is not connected to `services/api`, a database, a challenge secret
store, an HTTP route, an Apple client or a production WebAuthn verifier.

## CURRENT

The implemented scope is deliberately narrow:

- authenticated `authenticator.add` registration ceremonies;
- authenticated `session.step_up` authentication ceremonies;
- immutable account + session + device + purpose-target-digest binding;
- RP ID `auth.luxora.app`, exact allowlisted HTTPS origin binding, cross-origin
  denial, empty top-origin allowlist and `userVerification=required`;
- server vault contract for exactly 32 random bytes, while durable ceremony,
  event and receipt state contains only a secret reference and SHA-256 digest;
- five-minute default expiry, bounded response size and one to five attempts;
- revision compare-and-swap, command idempotency, create nonce idempotency and
  one terminal consume/cancel/expire/reject boundary;
- exact runtime-shape normalization for commands, persisted snapshots/receipts
  and verifier results; mutable caller inputs are copied before the first await;
- actor checks before state/revision errors, existence-concealing actor mismatch
  and error projections limited to safe state + revision metadata;
- discoverable registration plus explicit discoverable/non-discoverable
  authentication lookup boundaries, with only opaque secure-store references;
- separate sensitive credential write effects that must commit atomically with
  ceremony consumption and never enter event/outbox/log projections;
- zero/non-monotonic counter and backup-state risk signals, without treating
  counter telemetry as an automatic clone verdict or authentication failure;
- deterministic table, property and concurrent-race tests.

Registration is fixed to a discoverable credential, `residentKey=required`,
`attestation=none`, UP/UV required, and the version-1 ES256/RS256 allowlist.
Non-discoverable credentials are modeled only as an authentication lookup
boundary for compatibility; credential IDs stay behind `credentialSetRef`.

## Mandatory embedding rules

The embedding service, not the client, must construct the authenticated actor,
canonical purpose target digest and selected origin. The domain checks that the
origin is an exact member of the environment policy; it never accepts a
wildcard, path-bearing origin, HTTP origin or unrelated host.

`ExecutedCeremonyCommand` is a server-internal orchestration result. HTTP/client
adapters may project only the intended client requirements and their own opaque
ceremony handle; they must never serialize the aggregate, receipt or domain
error object as a client response. Domain errors intentionally retain no full
snapshot, actor IDs, challenge metadata or secure-store references.

`ChallengeSecretVault` must generate the 32-byte CSPRNG value on the server,
store the raw base64url value in a secret TTL store, and return an unrelated
opaque reference. Never log the raw value or include it in traces, events,
metrics, receipts or exception metadata. Ceremony CAS state is the authoritative
one-time-use record; vault deletion after a terminal commit is defense in depth.

`MaintainedWebAuthnVerifierAdapter` is a hard trust boundary. A production
adapter must name an exact reviewed library version and delegate all parsing and
WebAuthn cryptography to it, including response type, challenge, exact origin,
RP ID hash, UP/UV, algorithm, attestation/assertion signature, credential/account
and user-handle consistency. A fake verifier is used only in this package's
domain tests and provides no cryptographic evidence.

As one maintained-library integration candidate, current
[`@simplewebauthn/server`](https://simplewebauthn.dev/docs/packages/server)
exposes `verifyRegistrationResponse()` and `verifyAuthenticationResponse()`
with `expectedChallenge`, `expectedOrigin`, `expectedRPID` and UV enforcement.
Its [custom challenge guidance](https://simplewebauthn.dev/docs/advanced/server/custom-challenges)
explains how a server-supplied challenge is passed to generation and verification.
The actual adapter must be separately added, exactly pinned, reviewed and tested;
this package intentionally has no WebAuthn-library runtime dependency.

The production `PasskeyCeremonyStore.commit()` implementation must atomically:

1. compare the expected ceremony revision;
2. insert the unique command receipt (and creation receipt when beginning);
3. write snapshot, internal event and transactional outbox;
4. apply the secure credential insert/update effect;
5. enforce a global unique credential-ID constraint for registration.

When an initial commit also validates a server-owned authorization or grant
precondition, that check belongs in the same transaction and must happen before
any ceremony write. A failed check throws the exported
`StoreAuthorizationConflictError` without grant, token, actor or storage
detail. The executor first reconciles both possible receipts, so an ambiguous
commit that actually succeeded still replays; only a confirmed receipt miss is
mapped to coarse `FORBIDDEN`, with best-effort deletion of that attempt's newly
issued challenge.

Authentication updates must also compare and increment the credential row's
own revision and compare its account binding plus prior counter/BE/BS values in
that transaction. Ceremony revision CAS alone is insufficient because two
different ceremonies can authenticate the same credential concurrently, and
signCount may legitimately remain zero.

It must tolerate either CAS-first or receipt-uniqueness-first conflict ordering.
The executor re-reads matching receipts so identical races converge. The
size-bounded transport computes a server-derived SHA-256 digest over the exact
accepted WebAuthn response bytes. The verify command fingerprint binds that
digest and byte length, so same-length different responses cannot collide. The
receipt persists only the overall safe command fingerprint—not the response or
its standalone digest—and exact retries replay the first committed result.

On authentication, the maintained verifier must reject any BE value that does
not equal the immutable registration-time value. BS and counters are updated
only under reviewed policy, and the store independently compares prior
counter/BE/BS metadata and must never persist BS=true when stored BE is false.
Stored/new `0→0` remains supported for authenticators (including synced
credentials) that honestly do not implement a counter and emits
`signature_counter_not_supported`. When a stored non-zero counter is followed
by an observed zero, equal or lower value, the verified ceremony may consume
but emits `signature_counter_anomaly`. This is risk telemetry, not proof of a
cloned credential. The secure effect retains the exact observed value, while
the store must CAS the credential revision and persist a non-regressing counter
such as `max(previous, observed)`. Counter, credential and assertion details
must never enter public errors or logs; malformed counter shapes and immutable
BE mismatches still fail before ceremony consumption or any secure-store effect.

The executor samples expiry before verifier work and again after asynchronous
challenge resolution and verification. A result finishing at or after the
deadline expires the ceremony and cannot create a credential effect.

## TARGET / residual gates

Still absent and therefore not claimable:

- public passkey-first signup and identifier-free/usernameless sign-in;
- a production maintained-verifier adapter and W3C conformance/negative vectors;
- encrypted or otherwise reviewed distributed challenge secret storage;
- production database schema, global credential uniqueness, credential-row CAS
  and transactional outbox implementation with fault injection;
- HTTP contracts, request-body parser/fuzz corpus, rate limits and abuse controls;
- actual credential options assembly, account/user-handle lookup and session
  issuance;
- multiple-authenticator lifecycle, last-factor invariant and notification;
- step-up token issuance, recovery, QR/device linking or device-proof keys;
- Apple/Android/Web associated-origin integration and cross-platform interop;
- operational cleanup, alerting, retention, incident and rollback evidence.

The broad `Passkeys/WebAuthn` release gate remains open until those items pass.

## Verification

With the repository's Node 22 toolchain:

```sh
npm run typecheck
npm test
npm run build
npm run audit
npm run pack:check
```

The normative and implementation rationale is in
[`docs/specs/PASSKEY_PLATFORM.md`](../../docs/specs/PASSKEY_PLATFORM.md).
