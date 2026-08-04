# Passkey SQLite Repository Checkpoint — Beta-0.1

**Owner/developer:** Flenym  
**Evidence date:** 4 August 2026  
**Scope:** migrations `009_passkey_ceremony_repository` and
`010_passkey_step_up_grants`, API store contracts and the single-node SQLite
implementation

## Result

The repository now implements the `@luxora/passkey-domain` persistence contract
for the Beta-0.1 server checkpoint. One `BEGIN IMMEDIATE` transaction compares
ceremony revision and writes the aggregate, internal event, minimized outbox,
command/creation receipt and optional credential effect. A failed secure effect
rolls back every earlier write in that transaction.

This is not a production-database or distributed-vault claim. Evidence applies
to independent `better-sqlite3` WAL connections on one host. Multi-host
transactions, failover, PITR, KMS separation, online migration compatibility,
retention operations and distributed challenge cleanup remain release gates.

## Security/storage boundaries

| Boundary | SQLite enforcement |
| --- | --- |
| Challenge | 32 CSPRNG bytes; only AES-GCM ciphertext in TTL vault; distinct reference-bound AAD; aggregate stores reference + SHA-256 digest |
| User handle | one stable 32-byte handle per account; preparation is read-only/in-memory and an absent encrypted binding is installed only by the authorized registration transaction |
| Credential ID | globally unique SHA-256 digest index; canonical ID stored only as record-bound ciphertext |
| Credential material | public key, transports and immutable binding metadata are one record-bound encrypted envelope |
| Ceremony actor | account + session composite FK, explicit device ID, purpose type + target digest and immutable snapshot checks |
| Registration binding | ceremony and credential composite FK to `(userHandleRef, accountId)` |
| Credential CAS | record revision + account + discovery mode + prior counter/BE/BS + monotonic update time |
| Account limit | `< 20` rechecked inside the same immediate registration transaction |
| Receipts | actor-derived scope and one safe overall fingerprint; no raw response or standalone response digest |
| Outbox | schema-versioned state/risk projection only; no actor, challenge or credential material |
| Step-up grant | one row per consumed authentication; exact account/session/current-device/purpose/target/time binding; TTL ≤300 seconds; no raw JWT or `jti` |
| Registration authorization | verified claims + active session + durable grant are checked and CAS-consumed in the same `BEGIN IMMEDIATE` transaction as an absent handle binding and initial ceremony/event/outbox/receipts |
| Direct credential write | DB trigger requires a consumed linked grant and exact consumed-registration account/session/device/target projection |
| Direct mutation defense | active-session grants cannot be deleted/reinserted; credential identity, binding and encrypted material columns are immutable while authentication CAS fields remain writable |
| Final credential commit | rejects a backwards repository clock and rechecks exact active-session ownership at the actual commit clock before insert; failure rolls the whole mutation back |

Credential rows deliberately retain `registration_ceremony_id` as an immutable
scalar rather than an FK. Deleting a transient session/ceremony does not delete
or block the enrolled credential; account deletion remains its lifecycle
boundary.

## Race and integrity evidence

The focused repository suite covers:

- duplicate command receipt and stale ceremony revision convergence;
- two worker/SQLite connections racing one global credential ID;
- two ceremonies racing one credential-row revision;
- two writers racing the account credential limit at 19→20;
- rollback after a late credential-effect failure;
- one grant raced by two distinct registration begins on independent worker
  connections, with exactly one winner;
- two initially absent, independently prepared handle candidates raced through
  distinct grants; one binding wins and the loser receives a revision conflict
  before grant CAS, so its grant remains reusable;
- valid signed claims without their durable grant leave no user-handle,
  registration, receipt or challenge row;
- account/session/device/purpose/target/time mismatch, future/expiry boundary,
  reuse and ordinary-registration fail-closed behavior;
- commit-time session revoke/expiry races at grant creation, grant consumption
  and final registration-credential insertion, plus registration commit-clock
  rollback, including aggregate/event/credential/grant rollback;
- raw SQL orphan/mismatched grant and unlinked credential refusal;
- direct consumed-grant delete/reset and credential binding/material mutation
  refusal, while normal authentication CAS and parent session/account cascades
  remain operational;
- authentication-ceremony cleanup without deletion of the durable grant linked
  to a pending registration;
- clean creation, `009→010`, reopen and concurrent cold-start migration;
- composite account/session/user-handle FKs plus `integrity_check` and
  `foreign_key_check`;
- encrypted challenge/user-handle/credential persistence, wrong-AAD copy and
  ciphertext/snapshot/receipt corruption failure;
- expiry/attempt rehydration, bounded expired-secret purge and credential
  survival after session/ceremony retention.

Checkpoint commands:

```sh
cd services/api
npm run typecheck
npx vitest run \
  src/passkey-sqlite-repository.test.ts \
  src/migration-chain.integration.test.ts
npx vitest run \
  src/passkey-sqlite-repository.test.ts \
  src/passkeys/store-passkey-repository.test.ts \
  src/passkeys/simplewebauthn-adapter.test.ts \
  src/services/passkey-service.test.ts \
  src/http/passkey-response-body.test.ts \
  src/migration-chain.integration.test.ts
```

Observed migration-010 checkpoint: focused repository/service **2 files / 34
tests** and repository/service/migration **3 files / 46 tests** passed together
with typecheck and build. An earlier full API checkpoint passed **36 files / 279
tests** before the final SQL-trigger/output-contract hardening; the final
integration gate must rerun the full suite. These results remain
repository/single-node evidence, not a production database claim.
