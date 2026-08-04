# Luxora Passkey Ceremony Platform — Beta-0.1 foundation

**Owner/developer:** Flenym  
**Domain contract:** `@luxora/passkey-domain` v1  
**Status:** internal add/login/signup/authenticator-management seams in `services/api`; every routed seam is disabled by default and forbidden in production, capability discovery remains false, and none is an available product feature

## 1. Decision and truth boundary

This slice establishes the deterministic orchestration boundary that must sit
around a maintained WebAuthn server implementation. It does not parse CBOR,
client data, attestation objects or assertions and implements no WebAuthn
signature or attestation cryptography.

CURRENT repository evidence covers the audited domain, strict HTTP/raw-body
boundary, encrypted SQLite challenge/user-handle/credential records, exactly
pinned maintained verifier, purpose-bound one-time step-up grant, atomic
replay-safe addition of an authenticator for an already authenticated account,
and identifier-free primary login with atomic session issuance and bounded
response-loss recovery. An internal pre-account signup service now binds strict
canonical identity/device input to a first credential/account/session commit;
its bounded expiry reconciler is restart- and two-owner-safe. Migrations `014`–`016`
add encrypted authenticator labels/lifecycle, exact rename and a target-bound
one-time WebAuthn revoke ceremony that terminally disables verifier lookup and attributed
sessions while preserving a last active factor for password-disabled accounts.
That management slice has a strict default-off non-production Fastify composition,
but no independent notification delivery. Existing
authenticated/login routes use their non-production internal flag; signup uses
a distinct default-off flag with dedicated authorization and rotated refresh
roots plus active data encryption. Both flags are forbidden in production and
`features.passkeys` remains `false`. Public signup and primary-login enablement,
public authenticator-management HTTP/UX/notifications, recovery and client integration remain TARGET. The broad
Passkeys/WebAuthn checkbox must remain open.

| Capability | CURRENT | TARGET |
| --- | --- | --- |
| Versioned ceremony aggregate and commands | Implemented, stored and tested through the internal service | Selected production datastore/operations evidence |
| Account/session/device/purpose binding | Required for authenticated ceremonies; signup uses a distinct immutable pre-account candidate/device binding | Production identity, abuse and operations review |
| RP/origin policy | Exact `auth.luxora.app` / allowlisted HTTPS origin | Separate preview/staging/native identity evidence |
| Challenge | OS-random 32-byte secret encrypted in SQLite behind durable ref + digest; TTL and discard/purge paths | Distributed secret TTL store, KMS/cleanup SLO and incident evidence |
| WebAuthn verification | `@simplewebauthn/server` exactly pinned to `13.3.2`, with real fixtures and negative corpus | Ongoing advisory review plus Web/Apple/Android release-identity interop |
| Shared HTTP boundary | Strict begin JSON, exact raw verify transport, bounded WebAuthn JSON, safe projections and redaction tests behind independent internal flags; anonymous primary-login/signup locally aggregate canonical IPv6 by `/64` | Distributed limiting, admission/retention, public abuse/availability evidence and production enablement review |
| Registration | Atomic authenticated add plus a separately gated atomic pre-account first-passkey/account/session service, both with global credential uniqueness | Public first-authenticator release, multi-authenticator management UX and notifications |
| Authentication | Discoverable UV step-up for exact `authenticator.add`; internal identifier-free primary sign-in and atomic session issuance | Public abuse/timing/availability and cross-client release evidence |
| Authenticator lifecycle | Internally gated active-only list, encrypted label rename, target/revision-bound WebAuthn terminal revoke, originating-session invalidation, append-only audit/outbox/receipts and password-disabled last-factor invariant | Public route/UX review, independent notifications, distributed session fan-out and product interoperability |
| Recovery/device linking | Not implemented | Separate IA phases |

## 2. Relying-party profile

Policy version 1 binds:

- RP ID: `auth.luxora.app`;
- production browser origin: exact `https://auth.luxora.app`;
- no wildcard, arbitrary subdomain derivation, path/query/fragment or HTTP;
- no cross-origin iframe use and no accepted `topOrigin`;
- UP and UV required on both registration and authentication;
- registration `residentKey=required`, `attestation=none`;
- COSE algorithm allowlist: ES256 (`-7`) and RS256 (`-257`);
- client timeout and server expiry: 300,000 ms by default;
- opaque response maximum: 65,536 bytes;
- three attempts by default, policy-bounded from one through five.

An environment may instantiate a separate explicit allowed-origin list, but it
must use a separately reviewed credential namespace and deployment identity.
The command's origin is server-derived request context, never a client field.

## 3. Authenticated purpose binding

Every CURRENT ceremony stores the exact triple:

```text
accountId + sessionId + deviceId
```

and one purpose with a server-canonicalized SHA-256 target digest:

- registration: `authenticator.add`;
- authentication: `session.step_up`.

Verify and cancel compare all three actor identifiers before resolving the raw
challenge or invoking the verifier. The digest binds the ceremony to the exact
high-risk transaction without persisting the target body. Clients must never be
allowed to construct any actor identifier or target digest.

Actor authorization is evaluated before terminal-state or revision responses.
An actor mismatch is returned as existence-concealing `NOT_FOUND`, with no
snapshot. Authorized conflict errors expose at most state and revision; full
aggregates are never attached to error objects because routine structured error
logging would otherwise disclose actor IDs, challenge metadata and secure-store
references.

This authenticated ceremony aggregate intentionally does not use nullable actor
fields for unauthenticated signup or usernameless sign-in. Primary sign-in now
uses a separate internal pre-authentication intent/service with its own bootstrap
authorization, durable policy and enumeration review; signup uses its own
pre-account aggregate, authorization/refresh key domains and independent
non-production app gate. Both remain unavailable as public product features.

### 3.1. Internally gated authenticator management

The management service requires an already authenticated active session and
projects only opaque credential-record identity plus encrypted-at-rest display
label, lifecycle, revision, strong ETag and timestamps. Credential ID, public
key, user handle, counter, transports and WebAuthn payloads are forbidden from
the projection and durable event/outbox payload.

Rename is an exact account/session/target/revision/name command with a durable
fingerprint. Exact retry returns the encrypted receipt result; the same command
scope with changed semantics conflicts. Revoke uses a distinct
`authenticator.revoke` token purpose and SHA-256 target digest over account,
session, opaque credential record and expected revision. A grant may be minted
only from a consumed verified authentication ceremony with that digest, is
immutable, unexpired and consumed once in the same SQLite transaction as the
terminal lifecycle update.

Revoke keeps the globally unique credential digest to prevent re-registration,
but active-only verifier lookup rejects it immediately. Sessions created by a
verified signup/login store credential provenance; revoke marks those sessions
revoked and their refresh rows used atomically. Password-disabled accounts
cannot revoke the final active authenticator. Live transport cleanup is a
post-commit observable hook backed by durable outbox evidence; cross-process
delivery and independent user notification are not implemented.

The coordinator persists the revoke intent atomically with ceremony begin and
mints its grant only in the verified ceremony transaction. Strict list/rename/
revoke routes are composed with the authenticated ceremony family only when
`PASSKEY_INTERNAL_ROUTES_ENABLED=true` outside production. Default paths remain
`404`, conditional OpenAPI exposure is tested, and capability remains false.

## 4. Challenge lifecycle

`ChallengeSecretVault.issue()` is asked to issue exactly 32 bytes for the
ceremony TTL.
The current SQLite vault uses the operating-system CSPRNG, encodes the bytes as
canonical unpadded base64url, stores the value only as an AES-256-GCM envelope
with expiry and returns an unrelated opaque reference. Production still requires
an independently operated distributed TTL secret store and its KMS/cleanup
evidence.

The domain decodes the returned challenge, enforces exactly 32 bytes, computes
SHA-256 and persists only:

```text
challenge.reference
challenge.digest
challenge.byteLength = 32
```

At verification, the raw value is resolved transiently and compared with the
durable digest in constant time before handoff to the maintained verifier. The
raw value appears only in the begin client requirements and verifier call. It is
never part of a command, fingerprint, receipt, snapshot, event, outbox or safe
log projection.

The ceremony's transactional CAS state is the one-time-consume authority. A
vault deletion occurs after a terminal commit. If deletion fails, terminal CAS
still blocks replay and vault TTL bounds residual exposure; production must
alert and measure that cleanup failure.

Vault issue/resolve failures and malformed verifier failures are normalized to
coarse domain errors. Dependency exception text cannot cross the domain
boundary. A malformed issued challenge is discarded best-effort before the
generic failure is returned.

### 4.1. Internal HTTP transport boundary

The protocol and API service implement an authenticated ceremony family plus
an identifier-free primary-login pair:

| Route | Body |
| --- | --- |
| `POST /v1/auth/passkey-ceremonies/registration` | Strict JSON `{clientNonce, stepUpCeremonyId}` plus exact `Step-Up-Authorization: Bearer <compact-JWT>` for `authenticator.add` |
| `POST /v1/auth/passkey-ceremonies/authentication` | Strict JSON `{clientNonce, operation:"authenticator.add"}` for `session.step_up` |
| `POST /v1/auth/passkey-ceremonies/:ceremonyId/verify` | The raw registration or authentication credential JSON object |
| `POST /v1/auth/register/passkey/options` | Strict canonical username/display/device/nonces for pre-account registration |
| `POST /v1/auth/register/passkey/verify` | Raw registration credential plus `Bootstrap-Authorization`, `Idempotency-Key` and `If-Match` headers |
| `POST /v1/auth/passkeys/authentication/options` | Strict identifier-free JSON `{clientNonce, deliveryNonce}` |
| `POST /v1/auth/passkeys/authentication/verify` | Raw authentication credential plus `Bootstrap-Authorization`, `Idempotency-Key` and `If-Match` headers |

The API registers them only when `PASSKEY_INTERNAL_ROUTES_ENABLED` is explicitly
enabled outside production. The default is off, production configuration rejects
enabling it, and capability discovery remains `features.passkeys:false`. This is
an executable development/test seam, not public availability.

The signup pair instead requires
`PASSKEY_INTERNAL_SIGNUP_ROUTES_ENABLED=true` outside production, a dedicated
≥32-byte authorization secret, a complete signup-only rotated refresh
keyring/active ID, active AES-GCM data encryption and access TTL ≥601 seconds.
The authorization and every retained signup-refresh root must be mutually unique
and cannot reuse JWT, primary-login refresh or data-encryption material. Partial
configuration fails before composition. Signup-only enablement does not
register the authenticated or primary-login families; capability remains false.

The primary-login pair is wired only when the same internal flag is enabled and
a dedicated bootstrap-refresh keyring, active key ID and AES-GCM data-encryption
key are also present. Its options contain no username, account ID or
`allowCredentials`; account resolution happens only after the maintained
verifier authenticates the discoverable assertion. Successful verification
atomically commits credential telemetry, one session, one hash-only refresh row,
the consumed intent, event/outbox and receipt. Exact committed retries rederive
the same first bearer response within the durable recovery bound. A bounded
startup/periodic sweeper closes abandoned expired intents through the existing
writer-time and revision-CAS terminal mutation and clears their challenge.
Both fixed primary-login paths reject non-empty query strings before the service.
A different-command CAS loser receives a token-bound current state/revision
conflict and matching `ETag`; it is not misclassified as an invalid credential.

Pre-account signup is a separate gated service/transport and token namespace.
Begin does not query username or credential availability; verification atomically decides
global uniqueness while creating the password-disabled account, first handle and
credential, privacy defaults, session and hash-only token state. Its standalone
expiry reconciler samples one clock, processes bounded ordered batches and uses
deterministic intent-ID/revision/expiry proofs. SQLite writer-time/revision CAS
owns the terminal transition and atomically persists event/outbox/receipt while
deleting the challenge; exact receipt lookup reconciles restarts and competing
owners. Only explicit `BUSY`/`LOCKED` contention is retried with capped backoff.
The reconciler runs at startup and every ten minutes even while signup routes are
disabled, and app close clears the shared maintenance timer before Store close.

The service issues the bounded step-up token only after discoverable UV against
an already-bound credential, carries it in a separate header with the exact
authorizing ceremony ID in the strict registration body, and atomically consumes
the durable one-time grant when the new credential is committed. An ordinary
bearer session alone is insufficient because a stolen session must not be able
to bind an attacker credential.

Every command uses a canonical UUID `Idempotency-Key` header as the domain
`commandId`. Begin bodies carry the independent UUID `clientNonce`. Verification
uses `If-Match: "<revision>"` and exact media type
`application/webauthn+json` (an optional UTF-8 charset parameter is normalized).
Weak/multiple/wildcard/non-canonical entity tags are rejected.

The verify request body is the WebAuthn credential object itself—not a nested
wrapper. The internal HTTP transport caps and retains the exact accepted body
bytes at 65,536 bytes before JSON parsing, then derives their byte length and
SHA-256 for the internal verify command. A client cannot submit either value.
Re-serializing the parsed object is not equivalent because whitespace and escape
choices would change the original bytes and break exact idempotency semantics.

The outer credential and response objects reject unknown fields. IDs and binary
values use canonical unpadded base64url; credential IDs are capped at 1,364
characters / 1,023 decoded bytes, and the discoverable user handle at 64 bytes.
The standards extension result bag is explicitly open to registered extension
names, but is bounded to four nested levels, 32 keys/items per container and
8,192 serialized UTF-8 bytes, and rejects prototype-like keys and non-JSON
values. A maintained verifier still performs every semantic and cryptographic
check.

All ceremony responses and errors require `Cache-Control: private, no-store`.
Registration verification success returns only ceremony
ID/kind/purpose/state/revision, expiry, `verified:true` and replay status.
Authentication verification success additionally returns a bounded
`stepUpAuthorization` object with exact Bearer scheme, `authenticator.add`
purpose and expiry. That signed token is not authority by itself: the service
verifies the exact account/session/device/ceremony/purpose/target binding and
performs an atomic compare-and-consume of the durable one-time grant in the
credential commit. Invalid
assertions/attestations,
credential lookup failures and verifier details collapse to reviewed generic
reasons: `step_up_required`, `assurance_insufficient`, `challenge_expired`,
`ceremony_unavailable`, `ceremony_conflict`, `verification_failed` or
`temporarily_unavailable`. An authorized conflict may additionally expose only
current state and revision.

## 5. State machine

```text
                         invalid, attempts remain
                      ┌────────────────────────────┐
                      ▼                            │
begin ─────────────► pending ── verified ─────► consumed
                      │  │  │
                      │  │  └─ attempts exhausted ► rejected
                      │  └──── cancel ─────────────► cancelled
                      └─────── expiry ─────────────► expired
```

Every successful transition increments `revision` exactly once. All terminal
states are immutable. A verify/cancel received at or after `expiresAtMs`
produces `expired` without verifier execution. A sweeper cannot expire early.
The persisted begin snapshot is revision `1`; verify therefore sends
`If-Match: "1"`, and a successful consume returns revision `2`.

Rehydration accepts only the exact version-1 shape and active configured RP
policy. It rejects unknown fields, RP/origin drift, impossible revision/attempt
history, terminal timestamps inconsistent with expiry, risk signals on a
non-consumed ceremony and a challenge descriptor outside the 32-byte contract.

Invalid WebAuthn outcomes consume one attempt. An exact retry of the same
command ID replays its receipt and consumes no additional attempt. Transport or
verifier availability failures do not mutate the ceremony. Detailed verifier
failure text is deliberately dropped; only the coarse invalid/policy outcome
selects the rejected-attempt transition.

Expiry is sampled before verifier work and again after challenge resolution and
after asynchronous verification. A result that completes at or after
`expiresAtMs` produces only the expired transition and no credential effect.
An idempotent begin replay at or after the deadline never reissues raw client
requirements, even if a lagging vault implementation still resolves the secret.
Clock rollback relative to the durable `updatedAtMs` fails before challenge
resolution or verifier work; production still needs monitored, synchronized
time sources.

## 6. CAS, idempotency and race resolution

The store transaction takes `expectedRevision` and must atomically persist:

- aggregate snapshot;
- internal domain event;
- minimized transactional outbox;
- command receipt and optional begin-creation receipt;
- secure credential write effect, when verification succeeded.

An authentication write additionally carries the exact secure credential-row
revision read by the verifier. The store must CAS and increment that revision,
verify account ownership and compare prior signCount/BE/BS in the same
transaction. This second CAS is required across different ceremonies and still
works when an authenticator always reports signCount zero.

Command uniqueness is scoped to authenticated actor plus `commandId`.
Creation uniqueness is scoped to authenticated actor plus `clientNonce`. A
same key with different safe input is rejected. For verify, the bounded server
transport supplies SHA-256 of the exact accepted response bytes plus its byte
length. Both enter the safe command fingerprint, so equal-size different
responses are rejected as idempotency-key reuse. Neither the raw response nor
its standalone digest is stored; only the overall receipt fingerprint remains.
The first successfully committed exact request is authoritative.

Required race behavior:

| Race | Result |
| --- | --- |
| Concurrent identical begin | One ceremony; loser discards its orphan challenge and replays winner |
| Concurrent identical verify | One credential effect; both callers converge on one receipt |
| Different verify commands at one revision | One commit; loser receives current revision conflict |
| Verify versus cancel | One terminal CAS winner; losing secure effect is never persisted |
| Verify versus expiry | Commit-time revision decides; no second terminal transition |
| Retried invalid response | Exact command replay does not increment attempts again |
| Two ceremonies update one credential | One credential-row revision wins; the stale effect is rejected |

The executor reconciles stores that check receipt uniqueness before CAS and
stores that check CAS first. The current SQLite store enforces a global unique
WebAuthn credential ID in the same registration transaction; a future selected
production store must preserve that invariant.
Matching receipts are accepted only when their shape, result binding, active
RP policy, immutable ceremony fields and current aggregate are consistent;
receipts cannot resurrect a missing aggregate.

## 7. Maintained verifier boundary

The current `MaintainedWebAuthnVerifierAdapter` identifies
`@simplewebauthn/server` version `13.3.2` and an internal review reference.
Runtime code delegates all of these checks to that maintained library:

- response type and bounded parsing;
- expected challenge;
- exact expected origin and denied cross-origin/top-origin case;
- RP ID hash;
- UP and UV;
- versioned allowed algorithm;
- attestation format/trust policy for registration;
- attestation/assertion signature;
- credential ID, account and PII-free user-handle consistency;
- stored credential public key, credential-row revision and prior counter/BE/BS
  for authentication, including rejection when current BE differs and when a
  non-zero stored counter does not strictly advance.

The domain passes a single exact `expectedOrigin`, not a wildcard or broad array.
No application helper may partially pre-parse and then skip a maintained-library
check. The test adapter is a deterministic fake and is not security evidence.

Adapter output is untrusted runtime input even after cryptographic verification.
The domain accepts only exact result shapes, known coarse rejection reasons and
normalized credential fields. Unknown fields, wrong ceremony kind, missing
boolean flags, non-canonical credential IDs, duplicate/unknown transports or a
mismatched account/user-handle binding fail closed as verifier unavailability;
no adapter exception detail or decorated field is persisted.

The integrated Node adapter uses
[`@simplewebauthn/server`](https://simplewebauthn.dev/docs/packages/server),
whose verifier APIs accept the expected challenge, origin and RP ID and expose
registration credential material plus authentication counter updates. The
package is exactly pinned rather than accepted through a semver range;
dependency and advisory review remains an ongoing release obligation.

## 8. Credential metadata boundaries

| Data | Aggregate/event | Outbox/safe log | Secure credential effect |
| --- | --- | --- | --- |
| Raw challenge | Never | Never | Never |
| Challenge ref + digest | Yes | No | No |
| Opaque WebAuthn response | Never | Never | Never; transient verifier input only |
| Credential ID | No | No | Registration only |
| COSE public key | No | No | Registration only |
| PII-free user-handle reference | Registration aggregate | No | Registration only |
| Non-discoverable credential-set reference | Authentication aggregate | No | Verifier lookup only |
| Account/session/device IDs | Internal aggregate/event | No | Account binding only |
| Counter/BE/BS | Honest zero-counter/BS signals; supported counter or BE mismatch rejected | Accepted coarse signals only | Exact CAS-secured update |

The executor result is internal server data. The internal HTTP adapter does not
serialize its aggregate or receipt to a client; it projects only the reviewed
client requirements and an independently scoped opaque ceremony handle.

The one unavoidable exception is the transient begin-options response required
by WebAuthn itself: it contains the one-time raw challenge and, for registration,
the random PII-free `user.id` handle plus bounded `excludeCredentials`. That
response is authenticated, private/no-store and is never reused as an
authenticator-management projection. No finish/success/error/list response
contains challenge/reference/digest, user handle, credential ID, public key,
counter, attestation, assertion or verifier material.

Registration is discoverable-only in policy v1. The domain can model both
authentication lookup boundaries below, while the current HTTP contract exposes
only `discoverable` and fixes `allowCredentials:[]`:

- `discoverable`: no credential ID list/ref is exposed; the adapter verifies
  the returned credential and user-handle-to-account binding;
- `non_discoverable`: the aggregate holds one opaque `credentialSetRef`; only
  the secure adapter resolves it to `allowCredentials`/credential records.

## 9. Counter and backup policy

Accepted ceremonies may emit policy signals, not identity verdicts:

- both stored/new counter zero: `signature_counter_not_supported`;
- BS transition: `backup_state_enabled` or `backup_state_disabled`;
- registration BE false: `single_device_credential`;
- registration BE true and BS false: `backup_not_active`.

Stored/new `0→0` remains valid for authenticators, including synced
credentials, that honestly do not implement a signature counter. Once the
stored counter is non-zero, a new value less than or equal to it is a hard
verification failure. The maintained adapter must pass the real stored counter
to its reviewed verifier, normalize that failure to the same coarse invalid
WebAuthn-response rejection as other assertion failures, and retain at most a
coarse rejected metric. It must not expose or log received/stored counter,
credential, challenge or assertion details. The domain rechecks this invariant
as defense in depth: an adapter result labelled verified with a non-advancing
supported counter is treated as invalid verifier output and cannot consume the
ceremony or create a secure credential effect.

BE is registration-time immutable. The maintained verifier must reject an
assertion whose BE differs from the stored credential value; this is not an
accepted success carrying a risk signal. The store independently compares the
prior counter/BE/BS values and must never persist BS=true while stored BE is
false. BS can otherwise change. A rejected counter anomaly is not by itself a
durable clone verdict and must not automatically revoke a credential or lock an
account; any step-up, notification or review belongs to a separately reviewed
risk policy.

## 10. Evidence and remaining gates

Current automated evidence includes exact-policy and rehydration tables, safe
payload/error canaries, response-bound idempotency, attempt/expiry/clock/cancel
tables, discoverable-boundary cases, hard counter-rejection/no-effect and
zero-counter/backup tables, property tests and concurrent
begin/verify/cancel/credential-row races.

The shared protocol and internal service add strict begin inputs, exact raw
registration/authentication bytes, canonical base64url and credential-size
boundaries, bounded extension data, exact header/media-type contracts, safe
success/error projections, pinned maintained verification, encrypted SQLite
secret/credential storage, deterministic one-time step-up authorization and
atomic grant/credential CAS. Tests cover parser boundaries, malformed trusted
adapter output, token/grant/target substitution, session-revocation races and
exact committed replay without retaining raw WebAuthn material in receipts.
Management tests additionally cover encrypted migration backfill/reopen,
Russian and emoji labels with bidi-control rejection, exact ETag/lifecycle
projection, consumed/expired revoke authority, verifier exclusion, attributed
session/refresh invalidation, password-disabled last-factor protection,
append-only cross-bindings and independent SQLite rename/revoke writers. App
tests prove that this evidence does not compose or advertise a route.

Before any passkey capability is enabled, all of the following remain required:

1. selected production datastore migration/fault-injection evidence preserving
   the SQLite-proven atomicity, uniqueness, immutable binding and credential CAS;
2. distributed secret vault with KMS/IAM, entropy, TTL, cleanup and no-log evidence;
3. official/cross-implementation vectors, parser fuzzing and continuing
   dependency/advisory review beyond the current fixture/negative corpus;
4. distributed public-route rate limits, admission/backpressure, bounded
   anonymous-intent retention, abuse/availability evidence, operational
   monitoring and reviewed production enablement; local IPv6 `/64`
   aggregation alone is insufficient;
5. reviewed public exposure for the internal first-authenticator signup and
   usernameless primary sign-in foundations, with independent distributed
   enumeration/session-issuance evidence;
6. reviewed public HTTP/client exposure for the durable authenticator-management
   foundation, independent security notifications and distributed session
   cleanup/retry evidence;
7. Apple/Android/Web release-identity interoperability;
8. recovery, QR linking, retention, operations and incident gates.

## 11. Primary sources

Sources checked 4 August 2026. Luxora's exact origin, 32-byte challenge, attempts
and state machine are product decisions; the sources do not mandate those exact
product values.

- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/) —
  Candidate Recommendation Snapshot: RP/origin verification, 16-byte minimum
  challenge guidance, 300–600 second timeout range, UP/UV, discoverable
  credentials, counters and BE/BS semantics.
- [FIDO Alliance Passkeys](https://fidoalliance.org/passkeys/) — passkey,
  discoverable credential, device-bound/synced behavior and biometric privacy
  terminology.
- [`@simplewebauthn/server` documentation](https://simplewebauthn.dev/docs/packages/server) —
  maintained server verifier inputs/outputs and credential counter storage.
- [SimpleWebAuthn custom challenges](https://simplewebauthn.dev/docs/advanced/server/custom-challenges) —
  passing a server-supplied custom challenge through option generation and
  verification.
- [Identity/access platform](IDENTITY_ACCESS.md) — Luxora's complete TARGET
  authenticator, session, recovery and device-link policy.
