# ADR-0001: Strict single-use refresh rotation under races

- **Status:** Accepted for the current single-node foundation
- **Date:** 2026-08-03
- **Release:** Beta-0.1
- **Owner and developer:** Flenym
- **Decision scope:** access/refresh session semantics

## Context

A refresh token is single-use. Two requests can nevertheless present the same
token because of a stolen credential, a client bug, an ambiguous timeout or two
API processes reading the old row before either commits. A read followed by an
ordinary transaction allowed an independent writer loser to surface a generic
internal error and did not make the reuse decision at the serialization point.

Luxora must never create two valid descendants. It also cannot return the first
replacement to a loser: only the replacement hash is durable, so its raw value
cannot be recovered safely after commit.

## Decision

1. Clients must serialize refresh per device/session as one single-flight task.
2. The server may optimistically validate the presented hash and sign an access
   token, which is a side-effect-free operation, before consuming the refresh.
   This prevents a signer failure from burning the only usable refresh token.
3. Immediately before mutation, the store acquires a writer reservation and
   only then samples a fresh commit-time clock and re-reads token, session,
   revoke and expiry state. Validation uses the latest of the precheck,
   writer-reserved sample and prior durable lifecycle time; lock wait or a clock
   rollback therefore cannot make observed time move backward.
4. One compare-and-set consumes the old row and inserts exactly one hash-only
   replacement in the same transaction. Expiry is exclusive: `expiresAt <= now`
   is invalid, and a replacement keeps the earlier token/family or session
   absolute expiry rather than lengthening either bound.
5. A used-token observation or defensive CAS loss is strict reuse. The same
   transaction revokes the complete device session; the realtime terminator is
   called after commit. No grace window or second lineage is issued.
6. Therefore one racing request can receive a rotation response, but the reuse
   loser makes that apparent winner unusable. Both clients must discard the
   family and require sign-in/recovery.
7. Session/rotation audit timestamps use the latest of commit time, prior token
   creation and prior session activity so a wall-clock rollback cannot move
   durable lifecycle time backward.
8. If a driver error leaves the commit outcome ambiguous, the current
   implementation performs an authoritative reread. Observing the old token as
   consumed triggers durable session revoke and the normal reuse response.
   SQLite `BUSY`/`LOCKED` without observed consumption is a retryable `503`, not
   a leaked internal error and not evidence that a rotation committed.

The current SQLite implementation uses `BEGIN IMMEDIATE`. A production database
must provide an equivalent row-serialization/CAS guarantee and pass independent
process, authoritative-primary reread, pool/failover, lock-timeout and
ambiguous-commit fault injection before this ADR is treated as production
evidence.

## Alternatives considered

- **Allow both rotations:** rejected because it creates branching bearer-token
  lineages and weakens theft detection.
- **Return the winning replacement to duplicate callers:** rejected because the
  server deliberately stores only its hash; persisting recoverable raw tokens
  would enlarge the credential-compromise boundary.
- **Short duplicate grace window:** rejected for the current profile because a
  stolen token inside the window becomes indistinguishable from a retry.
- **Consume first, sign access afterward:** rejected because signing/KMS failure
  would strand a legitimate client and turn its retry into compromise handling.
- **Map CAS loss to a generic conflict without revoke:** rejected because it
  leaves an attacker-controlled winner active.

## Consequences

- Security is fail-closed and at most one replacement row is created.
- Legitimate concurrent retries cause session loss; Apple and all future clients
  must keep refresh single-flight and present a clear reauthentication path.
- An HTTP `200` refresh response is not proof that the session stayed active if
  another same-token request raced it.
- Durable revoke is the authorization authority. Local realtime termination is
  invoked after commit, but a transport-cleanup exception cannot change the
  committed auth result into `500`; cross-process fan-out and measured socket
  termination remain production gates.
- Reuse notification, token-family UI, sender-constrained tokens and recovery UX
  remain separate unimplemented gates.

## Migration and rollback

No schema migration is required. The store CAS now returns a boolean and the
service owns reuse classification at the writer boundary. Rollback to the prior
read-then-rotate behavior is not security-equivalent and requires a new ADR; a
safe emergency response is to disable refresh and require login rather than
allow parallel descendants.

## Evidence and review

- `services/api/src/auth-refresh-race.test.ts` covers same-process concurrency,
  a second independent SQLite writer, single-descendant/hash-only state, expiry
  after writer reservation, shorter family expiry retention, signer failure,
  clock jumps, defensive CAS loss, transport-cleanup failure, lock contention
  and commit-then-error reconciliation. It also proves the SQLite primitive is
  session-bound and rolls a standalone consume back if replacement insertion
  fails.
- `services/api/src/auth.integration.test.ts` retains ordinary rotation and
  post-reuse access rejection.
- Targeted acceptance: 19/19 tests plus production/test-source API typecheck on
  2026-08-03.

This is an internal engineering/security decision by Flenym with Codex review.
Production database behavior and external authentication review remain open.
