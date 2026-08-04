# Luxora Architecture

**Релиз:** Beta-0.1  
**Владелец и разработчик:** Flenym  
**Статус:** M0 single-node foundation; target sections are explicitly marked

## 1. Architectural intent

Luxora follows a protocol-first, native-client architecture. All clients must share identity, message, error, ordering and privacy semantics; they do not need to share UI code. Premium UX is downstream of correctness: no client is allowed to invent a receipt, security state or capability that the protocol cannot prove.

Hard delivery sequence:

`complete server platform → complete iPhone → iPad/macOS/Android/Web/Windows/Linux/public site`

The current backend is a runnable local foundation: text/realtime, partial rich
media/storage/search, IA-1 requests/relationships/blocks/reports, plus isolated
call-control and loopback SFU/TURN probes. It is not a complete server platform.
Completion still requires devices/passkeys/recovery, the full
conversation/community and media-processing model, push and synchronized
notification state, API-integrated call signaling/media operations, gated key
management/E2EE, moderation/jobs, production storage, backups, monitoring and
DR. A thin iPhone integration harness may verify real contracts during this
phase, but full iPhone product work waits for server stability. All other
client/public-site feature expansion is frozen; their existing code is a
portability/design probe.

## 2. Current runtime topology

```text
Local/native/Web prototype
        │ HTTP + WebSocket (when a real client is connected)
        ▼
Fastify application
  ├─ security headers / exact CORS / rate limits / schemas
  ├─ auth guard + AuthService
  ├─ ChatService + authorization invariants
  ├─ RealtimeHub (sequence, replay, heartbeat, backpressure)
  ├─ OpenAPI + health + Prometheus metrics
  └─ Store interface
        ▼
SQLiteStore
  ├─ SQLite WAL, FK, transactional migrations
  ├─ users/sessions/hash-only refresh tokens
  ├─ chats/members/messages/reads/reactions
  └─ per-user durable realtime events
```

The API, realtime gateway and repository run in one Node.js process. This is intentional for the runnable slice and is not a horizontally scalable production topology.

## 3. Current components

### 3.1. `packages/protocol`

Canonical Zod schemas and TypeScript types define:

- release and protocol version constants;
- IDs, timestamps, username/password bounds;
- users, sessions, chats, messages and reactions;
- strict mutation inputs and cursor pagination;
- HTTP error taxonomy;
- client/server realtime envelopes and durable events.

Unknown mutation fields are rejected. Message length is counted in Unicode code points and capped at 10,000. Pagination hard max is 100. Protocol build must precede API build because the API imports the package artifact.

### 3.2. API/application layer

- `app.ts` composes plugins, services, storage and error handling.
- `http/routes.ts` parses untrusted input at the boundary and attaches auth guards.
- `AuthService` owns register/login/refresh/session behavior.
- `ChatService` owns membership checks and message mutations.
- `TokenSecurity` owns JWT and refresh-token primitives.
- `RealtimeHub` owns live connections but durable history remains in `Store`.

Controllers stay thin. Business authorization belongs in services/repository operations, never only in UI or route names.

### 3.3. Storage layer

`Store` is the seam for future storage migration. Current `SqliteStore` uses WAL, `foreign_keys=ON`, `busy_timeout=5000` and `synchronous=NORMAL`. Schema migrations execute transactionally and are recorded in `schema_migrations`.

When configured, AES-256-GCM protects only message bodies and serialized durable event payloads. Account metadata, chat membership, timestamps and indexes are not field-encrypted by this hook. The process decrypts content, so this is **not E2EE**.

### 3.4. Realtime ordering

1. A socket receives `hello`.
2. The client authenticates within five seconds with an access token and optional `resumeFrom`.
3. The server validates the session, binds the connection to user/session and returns `ready`.
4. Durable events use a monotonically increasing SQLite sequence and per-user audience.
5. Up to 500 missed events replay. Overflow returns `sync.required` and requires HTTP reconciliation.
6. Heartbeats, stale-connection cleanup and buffer caps bound resource use.
7. Typing and presence are ephemeral; message mutations/read/reaction events are durable.

The global SQLite sequence may contain gaps for a given user. Clients track the last received server cursor for their authorized stream and reconcile when instructed; they never assume numeric adjacency implies authorization.

## 4. Client architecture state

| Client | Current data source | Current role | Network status |
| --- | --- | --- | --- |
| iPhone/iPad/macOS SwiftUI | local preview or `ApplicationSession` + in-memory `MessengerStore` | Design foundation and thin server integration harness | Partial: auth/chat load/send/message realtime |
| Android Compose | `MessengerState.demo()` | Portability/layout foundation | Not connected |
| Web React | Static arrays + component state | Landing and interaction prototype | Not connected |
| Electron Windows/Linux | Packaged Web build | Hardened shell/packaging probe | No messaging integration |

During the server phase, a thin iPhone integration harness establishes and continuously verifies the canonical client boundaries:

```text
SwiftUI Views
  → feature models / reducers
  → sync coordinator
  → protocol DTO adapter
  → HTTP client + realtime client
  → encrypted credential store + durable local database/outbox
```

The harness is not the full product: it may expose only synthetic/test flows needed to validate server semantics. After the entire server platform passes its gates, the full iPhone app reuses those tested layers and implements the complete UX. iPad, macOS and every other client remain frozen until both server and full iPhone are stable.

## 5. Invariants

- Every durable object has an opaque stable ID; UI position is never identity.
- Actor identity comes from the authenticated principal, never request body.
- Every object access checks membership/ownership server-side.
- Send idempotency is scoped by sender and client nonce.
- Edit uses revision preconditions when provided; conflicts preserve user work.
- Delete is a tombstone in current shared history, not proof of physical erasure from all backups.
- Read cursors cannot point to a message outside the conversation.
- Session revoke invalidates refresh/HTTP and actively closes matching realtime connections.
- Realtime resume is account/session-bound and bounded.
- Client time does not define canonical order.
- No plaintext fallback may ever be introduced for a future E2EE conversation.

## 6. Trust boundaries

### Current Cloud preview

`client plaintext → TLS edge → application plaintext → optional field-encrypted SQLite → authorized client`

TLS protects transport. Optional data encryption reduces raw file/snapshot exposure but not a compromised process/operator. Logs must exclude content, credentials and exact sensitive queries.

### Target Private (not implemented)

`client plaintext → audited local encryption → opaque delivery/storage → authenticated device decryption`

Requires per-device identities, mature maintained crypto libraries, forward secrecy/post-compromise security, group key management, key transparency, verification UX, local search, encrypted attachments/backups and independent audit. See [SECURITY.md](SECURITY.md).

### Target Moderated (not implemented)

Server-readable spaces support moderation and search with explicit pre-join disclosure, purpose limitation, RBAC, audit and retention. A trust class is immutable after content exists; migration creates a new container.

## 7. Evolution path

### Stage A — finish the current text vertical slice

- Close all M0 auth/authorization/realtime negative cases.
- Add API schema compatibility/conformance fixtures.
- Define cursor retention and reconciliation semantics.
- Add local backup/restore evidence and operational dashboards.
- Remove unsupported security/call/download claims from all surfaces.

### Stage B — complete the server platform

- CURRENT IA-1 message-request/discovery/block/report boundary; remaining auth devices/passkeys/recovery and privacy lifecycle.
- Directs, groups, channels, topics/comments, roles/permissions and all message actions.
- Object storage, chunked/resumable media/files, voice/video notes and processing boundaries.
- Search, push, presence/receipts, jobs, retention and abuse/moderation.
- Call signaling plus SFU/TURN/screen-share lifecycle and capacity evidence.
- Gated per-device key management/E2EE, transparency, backup and independent audit.
- Production storage, queues, monitoring, backups, restore, DR and operational access.
- Thin iPhone harness for contract/offline/interoperability evidence only.

### Stage C — complete iPhone

- Implement every planned iPhone product flow over stable server capabilities.
- Close accessibility, localization, performance, energy, poor-network, push and security gates.
- No local demo fallback on a claimed working surface.

### Stage D — unfreeze all remaining clients and public site

Only after stable server + full iPhone: iPad/macOS, then Android/Web/Windows/Linux and the public site implement proven contracts and full truth gates. Platform order inside this phase follows product evidence and staffing. Shared conformance does not require shared UI code.

## 8. Target scalable topology (not implemented)

```text
Clients
  → CDN/WAF/TLS ingress
  → Auth/API services ───────────────→ PostgreSQL metadata/envelopes
  → Realtime gateways ──────────────→ durable event log / fan-out
  → Upload broker ──────────────────→ object storage + quarantine/transcode
  → Push workers ───────────────────→ APNs/FCM/Web Push
  → Search (Moderated only)          → permission-filtered index
  → Calls signaling/SFU/TURN         → no media keys in gated E2EE design

All services → redacted logs, metrics, traces, alerting and audited KMS
```

Scale claims require representative load tests, failure tests, RPO/RTO game days and capacity evidence. SQLite is never promoted by merely putting its file on a shared volume.

The call-control, grant, SFU/TURN and media-security contract is specified
separately in [docs/specs/CALLS_PLATFORM.md](docs/specs/CALLS_PLATFORM.md).
`packages/call-control` is an isolated audited reducer/persistence/grant
foundation and the local containers are an infrastructure probe; neither is an
available calling feature or an API integration.

## 9. Architecture decision rules

Create an ADR before changing trust class, auth/token semantics, storage engine, event ordering, client offline model, crypto profile, push plaintext, media processing or service boundaries. Each ADR records context, decision, alternatives, consequences, migration/rollback and security reviewer.

ADR index: [docs/adr/README.md](docs/adr/README.md).

Architecture review must answer:

1. What user-visible semantic changes?
2. What happens with one-version-old clients?
3. How are retry, duplicate, offline, conflict and partial failure handled?
4. Which trust boundary receives new data?
5. What telemetry is safe and sufficient?
6. What is the rollback path without data loss or security downgrade?

Canonical requirements: [docs/specs/PRODUCT_REQUIREMENTS.md](docs/specs/PRODUCT_REQUIREMENTS.md), [docs/specs/THREAT_MODEL.md](docs/specs/THREAT_MODEL.md), [docs/specs/RELEASE_QUALITY_GATES.md](docs/specs/RELEASE_QUALITY_GATES.md).
