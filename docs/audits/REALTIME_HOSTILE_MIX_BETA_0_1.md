# Realtime hostile-mix checkpoint — Beta-0.1

Owner and developer: Flenym  
Checkpoint: 2026-08-03  
Scope: deterministic single-process/loopback abuse and backpressure boundaries
for the current `/v1/realtime` and `/v2/realtime` gateways.

## Implemented local bounds

| Boundary | Current policy | Failure behavior |
| --- | --- | --- |
| Inbound frames | 120 frames per connection per fixed 10-second window, counted synchronously before the per-connection promise chain. | One `RATE_LIMITED` error, then close `1008`; later frames are discarded. |
| Typing frames | 8 `typing.start`/`typing.stop` commands per authenticated connection per fixed 5-second window, in addition to the existing 800 ms per-chat throttle. The global check runs before chat/member lookups. | First excess command returns `RATE_LIMITED`; the rest of that window are silently dropped and the connection remains usable. |
| Authentication attempts | 60 authenticate frames per source IP per fixed minute, shared by V1 and V2 and checked before JWT verification. | `RATE_LIMITED`, close `1013`. |
| Pending authentication | At most 16 unauthenticated sockets per source IP. | No `hello`; `RATE_LIMITED`, close `1013`. The slot is released on every close. |
| Device session sockets | At most 4 authenticated sockets for one immutable device-session ID across V1/V2. | `RATE_LIMITED`, close `1013`. The slot is released on close. |
| Pending event queue | At most 1,000 durable events while a registered connection is not active. | Best-effort `sync.required(backpressure)`, queue cleared, close `1013`; authoritative replay remains in SQLite. |
| Outbound socket buffer | The already-buffered bytes plus the serialized next frame may not exceed 1,000,000 bytes. | Best-effort `sync.required` only if it fits, queue cleared, close `1013`. |

Each rejection increments
`luxora_realtime_guard_total{reason="auth_rate|backpressure|frame_rate|pending_connections|session_connections|typing_rate"}`.
The authenticated socket gauge is decremented through the existing hub close
path.

## Executable evidence

`services/api/src/realtime-hostile-mix.integration.test.ts` first reproduced the
missing/unsafe behaviors, then locks the repaired boundary:

1. a heartbeat flood cannot grow the asynchronous command chain without bound;
2. rotating across valid chat IDs cannot bypass the connection-wide typing
   bucket, and a limited connection can still heartbeat;
3. pending-queue overflow and projected outbound-buffer overflow both clear
   process memory and close exactly once with `1013`;
4. the fifth concurrent socket for one device session is refused, while closing
   an accepted socket releases a replacement slot;
5. delayed JWT verification cannot register a ghost hub connection after the
   socket has closed, and already queued callbacks stop before database work;
6. per-chat typing timestamps prune expired/future-clock entries and remain at a
   deterministic eight-chat cap;
7. repeated invalid authentication across V1/V2 reaches a shared per-IP bound,
   failed reconnects release pending slots, and the seventeenth concurrent
   unauthenticated socket is refused;
8. an explicit trusted-proxy chain ignores prepended forwarding values and
   expanded/compressed IPv6 rotation while retaining one V1/V2 authentication
   bucket.

The focused checkpoint is 1 file / 8 tests. Existing realtime delivery,
authorization, identity, reconciliation and outbox focused suites remain green
alongside it (6 files / 40 tests at this checkpoint). The final combined API
gate passed production typecheck, test typecheck, all 28 files / 168 tests, and
the production TypeScript build.

## Honest boundary

This is not a production load, capacity or distributed-abuse claim. All counters
and connection maps are process-local fixed windows and reset on restart. The
source key passes Fastify's explicitly CIDR-anchored `request.ip` through the
same canonical IPv4/IPv6 boundary as HTTP. Direct mode ignores forwarding
headers. A deployment must still prove ingress header rewriting, proxy source
CIDRs and absence of a direct bypass; see `CLIENT_IP_TRUST_BETA_0_1.md`.
Fixed windows permit a boundary-aligned burst. Multi-replica deployments need a
shared/risk-aware limiter or ingress enforcement, coordinated connection state,
cardinality/latency dashboards and alerting.

The loopback harness does not simulate thousands of clients, WAN loss, TLS
termination, proxy buffering, kernel/socket pressure, 1/5/15-minute outages,
multi-process fan-out or whether mobile clients implement jitter correctly.
Production reconnect/load evidence and capacity thresholds therefore remain an
open release gate.
