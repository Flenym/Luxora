# Luxora single-node realtime outbox — Beta-0.1

Owner and developer: **Flenym**  
Checkpoint: 2026-08-03

## Implemented boundary

`SqliteStore.appendEvent` writes the encrypted audience event and its
`realtime_outbox` row inside one SQLite transaction. Service-level domain
transactions contain that savepoint, so domain state, every audience event and
every matching outbox row commit or roll back together. `appendChatEvent` also
wraps its complete audience batch.

`RealtimeOutboxPublisher` is the only durable publisher used by chat,
identity/access and upload mutations in the application composition root. It
claims due rows under a writer reservation, assigns a random worker owner and
lease, publishes one sequence at a time to `RealtimeHub`, then records
`published_at`. It never turns a post-commit publisher, clock or logging failure
into an HTTP error.

## Failure model

- Crash before domain commit: domain, event and outbox all roll back.
- Crash after commit but before publication: pending row is claimed on the next
  poll or process startup.
- Crash during a claim: lease expiry makes the row reclaimable.
- Crash after publication but before acknowledgement: the event can be
  published again; clients deduplicate durable events by sequence.
- Delegate failure: the row is released with capped exponential backoff.
- Corrupt/unknown encrypted event: that row is isolated from the batch, retried
  to the bounded attempt budget, then retained with
  `failed_at=.../failure_code=event_unreadable`; later rows continue.
- Repeated local publish failure: retained with `failure_code=publish_failed`.
- Ack/release/dead-letter storage failure: the owned lease remains the recovery
  boundary; no event is acknowledged or deleted speculatively.
- Invalid clock or throwing log/metrics callback: contained inside the worker;
  the already committed command remains successful and pending state remains.
- Startup without sockets: the local hub publication attempt can be recorded,
  while the event log remains intact for cursor replay after reconnect.
- Producer clock ahead of the publisher: an initial row is unconditionally due;
  logical event time cannot postpone its first claim. Retry release is the only
  path that moves `available_at` into the future.

This is at-least-once local publication, not exactly-once client delivery.

## Explicit production gate

This worker does **not** provide cross-process fan-out. Multiple API processes
competing for one SQLite outbox row cannot guarantee that the claiming process
owns every relevant WebSocket. Production horizontal scale requires a reviewed
broker such as Redis Streams or NATS JetStream, per-process subscription/fan-out,
idempotent sequence keys, retention/consumer recovery, alerts and reconnect/load
evidence. The repository makes no contrary claim.

Durable failed rows also need an operational alert and reviewed inspect,
repair/requeue and retention runbook before production approval.

## Verification

```bash
npm --prefix services/api run typecheck
npm --prefix services/api test -- --run \
  src/realtime-outbox.test.ts \
  src/identity-migration.test.ts
npm --prefix services/api test
npm --prefix services/api run build
```

Checkpoint result: nine focused outbox cases plus the migration case passed
10/10; production/test-source typecheck and production build passed. The final
aggregate API count is recorded in `TESTING.md` after all parallel checkpoints
settle.
