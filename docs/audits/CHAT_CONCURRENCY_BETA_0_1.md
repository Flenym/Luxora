# Luxora chat concurrency checkpoint — Beta-0.1

Owner and developer: **Flenym**  
Checkpoint: 2026-08-03

## Outcome

The current single-node SQLite chat path now converges under tested independent
connections instead of leaking raw SQLite contention/uniqueness failures. Send
and forward idempotency, edit history, delete tombstones, read pointers,
delivered/read receipts and reaction desired state are serialized by database
commit order. The tests include server clocks offset by minus/plus 24 hours.

This is evidence for the repository's SQLite Beta foundation. It is not proof
for a future production database, replicas, failover, distributed fan-out or a
complete randomized concurrency model.

## Remediated failure modes

| Pre-remediation failure | Current control |
| --- | --- |
| Two writers using one send nonce could surface raw `UNIQUE` as HTTP 500, while later edit/delete changed the fields used to recognize an exact retry. | The command reserves the SQLite writer first. Migration `008_message_request_fingerprint` stores an encrypted immutable canonical command fingerprint, so exact retries return the current projection of the first result and changed reuse is a stable `409`. |
| Forward retries had the same race and could become non-idempotent after the source changed. | Migration `007_forward_request_identity` stores the immediate source message as an internal nullable self-FK; migration `008` stores the complete command fingerprint. Exact retries return the immutable first snapshot even after source edit/delete; a new nonce against a deleted source is still `404`. Ambiguous legacy rows fail closed with `409`. |
| Concurrent edits could collide in `message_versions`, return 500 or corrupt revision history. | The current message is re-read under `BEGIN IMMEDIATE`; every edit versions and CAS-updates the authoritative current revision. Expected-revision losers return `409`; unguarded edits serialize into consecutive revisions. |
| A behind server clock could make a later edit/delete/send appear earlier. | Message aggregate timestamps use the wall clock only when it is strictly above the committed aggregate floor; otherwise the service advances the floor by one millisecond. Commit order therefore remains strict even at equal or minus-24-hour clocks. |
| Concurrent read/delivery operations could return `SQLITE_BUSY`, regress the read pointer or persist `readAt < deliveredAt`. | Receipt mutations reserve the writer before reading. Read advancement uses immutable `(created_at,id)`, `chat_reads.read_at` is nondecreasing, read implies delivery, and the emitted event carries the actual persisted timestamp. |
| A command waiting behind a relationship mutation could continue using stale permission checks. | Send, forward, edit, read, delivered and reaction paths repeat current membership/chat/topic/direct-relationship checks after writer reservation. Delete deliberately remains available to its author after a Direct block. |
| A logically future event timestamp could delay its initial outbox publication. | A new outbox row is unconditionally due from the epoch sentinel; `available_at` is used for retry backoff only after an attempted publication. |

Delete removes pending create/update content events, history/search/pin state and
then emits only the authoritative tombstone. Reactions apply desired state in
writer commit order; their event sequence, not an untrusted process clock,
defines durable ordering.

## Executable evidence

```bash
cd services/api
npm run typecheck
npx vitest run \
  src/chat-concurrency-race.test.ts \
  src/realtime-outbox.test.ts \
  src/identity-migration.test.ts \
  src/migration-chain.integration.test.ts \
  --reporter=verbose
npx vitest run src/auth-refresh-race.test.ts --reporter=verbose
npm test -- --reporter=dot
npm run build
```

Checkpoint results:

- chat concurrency: 17/17 focused cases, including 12 independent-writer races;
- outbox plus migration: 10/10 cases;
- combined chat/outbox/migration command: 4 files / 38 tests;
- refresh regression: 1 file / 15 tests;
- all named focused files together: 5 files / 53 tests;
- production/test-source typecheck and production build: passed.

## Open gates

- Repeat the model against the selected production database across real pools,
  replicas, failover and ambiguous network outcomes.
- Add randomized schedule/property/fuzz coverage beyond the deterministic
  writer-hold harness.
- Add production metrics for nonce conflicts, revision conflicts, lock wait,
  clock-floor advancement and receipt lag without user/content identifiers.
- Cross-process realtime fan-out is still absent. The SQLite outbox provides
  local at-least-once publication plus authoritative cursor replay, not broker
  delivery to sockets owned by every API process.
- Rows created before migration `008` have no immutable send fingerprint and
  deliberately return `409` on nonce replay. Pre-`007` forward rows are also
  ambiguous. This fail-closed compatibility tradeoff avoids returning the
  outcome of a different command; clients must use a fresh nonce after upgrade.
