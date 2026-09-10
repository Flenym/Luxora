# ADR 0002 — Phone-password recovery and legacy phone binding

- Status: Accepted (server slice complete, client wiring open)
- Date: 2026-09-10
- Owner: Flenym
- Scope: Beta-0.1 server (migration `026_phone_recovery_and_binding`)

## Context

`019_phone_password_challenge` introduced an optional post-OTP secret password
for phone-bound accounts. Once enabled, a user who forgot that password could
never log in again: `verify` returned `password_required` and the continuation
grant required the forgotten value. Separately, accounts created through the
legacy username/password register endpoint had no path to attach a phone
identity, so phone login and the phone password stayed unreachable for them.

The handoff prompt (section 6.2) required an explicit ADR decision for any
`password_required` step-up contract work instead of silently reusing login
material.

## Decision 1 — recovery is a delayed reset, not an immediate bypass

A forgotten phone password is recovered through a deliberately delayed,
bounded, durable intent:

1. `POST /v1/auth/phone/recovery/start` requires the short-lived
   `passwordToken` from a verified `password_required` challenge. The OTP has
   already proven possession of the verified phone; the intent itself stores
   the resolved user, phone digest and a unique HMAC-digested recovery token.
2. Completion is impossible before `confirmAt = start +
   PHONE_AUTH_RECOVERY_DELAY_SECONDS` (config: 0–7 days, default 300 s;
   **production startup rejects < 3600 s**). The window is the compensating
   control that keeps the secret password meaningful against SIM-possession
   attacks: it gives the owner time to notice and complete a normal login.
3. A successful normal login (correct password) does not cancel the intent in
   this slice; the intent is single-use and time-bounded
   (`PHONE_AUTH_RECOVERY_TTL_SECONDS`, default 24 h) instead. Rebinding the
   password afterwards re-arms the protection.
4. Completion atomically sets a new Argon2id hash (enabled), revokes **all**
   active device sessions and push registrations of the account, creates the
   replacement session for the recovering device, and records append-only
   receipts and `phone.recovery.*` events. Concurrent starts collapse to one
   intent per account (partial unique index); exact retries replay the stored
   encrypted response; changed fingerprints conflict.

Rejected alternatives: immediate reset after OTP (negates the second factor),
recovery e-mail (no e-mail channel exists in Beta-0.1), 7-day hard-code
(delay is configurable so local preview and tests stay honest without lying
in production), recovery codes (out of scope without a second channel).

## Decision 2 — binding reuses the OTP state machine, availability only after OTP

Legacy accounts bind a phone through a dedicated `phone_binding_challenges`
table that mirrors the login challenge state machine (pending_delivery →
pending → verified → consumed, with locked/expired), rather than overloading
`phone_auth_challenges` (whose `verified` CHECK is registration-specific and
would require a table rebuild).

- `POST /v1/me/phone/binding/challenges` is authenticated; it refuses accounts
  that already own a phone identity (their own data) and never reveals whether
  the requested number belongs to someone else (no pre-OTP enumeration).
- Verify runs through the shared `POST /v1/auth/phone/challenges/:id/verify`
  route and returns a new additive union member
  `{status:"binding_verified",bindingToken,...}`. Wrong codes consume the same
  bounded attempt budget with durable payload-free failure receipts.
- `POST /v1/me/phone/binding/complete` re-checks the owner, then atomically
  inserts `phone_identities` only while the number is still unbound; a taken
  number consumes the grant with a generic `409` and a `phone_unavailable`
  receipt.

## Consequences

- One phone identity per account remains the invariant; binding is single-shot.
- Recovery receipts are response-bearing (`started`, `completed`) and
  immutable; events are append-only with database triggers.
- New API error codes: `PHONE_AUTH_RECOVERY_TOKEN_INVALID`,
  `PHONE_AUTH_RECOVERY_NOT_CONFIRMABLE`, `PHONE_AUTH_BINDING_CHALLENGE_INVALID`,
  `PHONE_AUTH_BINDING_TOKEN_INVALID`.
- Open follow-ups: real SMS provider wiring, iPhone UI for both flows,
  distributed rate-limit evidence, production fault injection, and a future
  decision whether a normal login should cancel a pending recovery intent
  (recorded as a product question for Flenym).
