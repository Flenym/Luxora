# Luxora HTTP and realtime authorization matrix — Beta-0.1

Owner: Flenym  
Checkpoint: 2026-08-03  
Scope: every explicitly registered current HTTP resource/action, both current
WebSocket endpoints, every current client command, and every current durable
event audience branch.

## Claim boundary

This is an executable matrix for the routes and schemas that exist now. It does
not claim coverage for future membership mutation, moderation, calls, passkeys,
push, export/deletion, administration, or E2EE surfaces because those endpoints
do not exist. A source-inventory assertion fails when an explicit HTTP route,
dynamic realtime path, client command variant, or durable event branch is added
without updating the matrix.

Evidence labels below map to named tests:

- `H-INV`: explicit route-source inventory equals the public-policy list plus all
  49 protected HTTP rows.
- `H-UNA`: invalid authentication is table-tested on all 49 protected rows;
  every response is `401`, contains no ID/content/profile/token canary, is
  `private, no-store`, and creates no durable event.
- `H-SCOPE`: unrelated-account probes cover every self/account collection and
  search/reconciliation projection without foreign canaries or events.
- `H-ORACLE`: existing-foreign versus random UUID pairs compare status, public
  error code/message, canaries, state, session liveness, and event sequence.
- `H-NEST`: wrong-chat message/topic IDs are rejected before state/event change.
- `H-ROLE`: owner/admin/member/outsider and author/non-author HTTP checks.
- `H-DIRECT`: accepted Direct operations, either-direction block cutoff,
  retained-history policy, and own-delete exception.
- `R-INV`: both dynamic WS paths, six client commands and 19 durable audience
  branches are source-inventoried.
- `R-UNA`: every non-auth command and invalid authentication are denied on both
  protocols before ready/state change.
- `R-CMD`: foreign/cross-chat commands, group/channel membership, allowed typing
  and receipts, response canaries, and event absence.
- `R-DIRECT`: blocked Direct typing/receipt denial with no peer event or durable
  side effect.
- `R-CHAT`: all 11 chat-scoped durable events are delivered to a current member
  and filtered for an outsider.
- `R-ACTOR`: attachment-owner and all seven identity/audience branches are
  produced and replayed only for their intended accounts.
- `EXISTING`: deeper media, identity, refresh-session, cursor, reconciliation,
  relationship and logging regressions in the existing focused suites.

## Concealment and denial policy

1. Missing/invalid/revoked credentials are `401 UNAUTHENTICATED`.
2. A private standalone object that the actor cannot know through an authorized
   collection is concealed as the same generic `404` used for a random UUID.
   This applies to foreign sessions, message requests, chats, messages, topics,
   uploads, attachments, and reaction/receipt reads.
3. A current chat member may know that a message/topic exists. Missing business
   role or authorship is therefore an intentional `403 FORBIDDEN`, not `404`.
4. A foreign or absent outer chat ID returns the same generic membership `403`
   on collection/nested routes; the response does not distinguish existence.
5. A nested ID from another chat returns `404` after the outer chat membership
   check and before mutation.
6. A blocked or unaccepted Direct returns generic relationship `403` for active
   mutations and ephemeral commands. Historical chat/message/pin reads remain
   available to members by current product policy; either participant may still
   delete their own historical message.
7. Denials must contain no referenced object ID, message/file content, private
   profile, access token, range total, or target-only event, and must not change
   state or append durable events.

## Public and configuration-dependent HTTP policy

These are not labelled IDOR surfaces.

| Surface | Policy | Cache policy | Evidence |
| --- | --- | --- | --- |
| `GET /health/live` | Public liveness and canonical release label only. | Public; no forced private header. | `H-INV`, public-policy test |
| `GET /health/ready` | Public dependency readiness and release label only. | Public; no forced private header. | `H-INV`, public-policy test |
| `GET /metrics` | Public only when `METRICS_TOKEN` is absent. When configured, exact bearer token is required using timing-safe comparison; denial is generic. | No user resource data; no forced private header. | `H-INV`, configured and unconfigured probes |
| `GET /v1/capabilities` | Public, account-free compatibility contract. Reports canonical protocol versions, trust posture, feature flags and configured runtime limits; it contains no user or deployment secret. An invalid bearer is ignored and produces the same response as no bearer. | Explicit public `no-store`/`no-cache`, without `private`, because version/security negotiation must not be served heuristically stale. | `H-INV`, false/true search wiring, response-schema/exact-runtime-value/OpenAPI probes |
| `POST /v1/auth/register` | Unauthenticated credential bootstrap with network rate limit; creates only the registering account/session. | Sensitive `private, no-store`. | `H-INV`, auth suites |
| `POST /v1/auth/login` | Unauthenticated credential verification with generic failure and rate limit. | Sensitive `private, no-store`. | `H-INV`, auth suites |
| `POST /v1/auth/refresh` | Unauthenticated bearer-family rotation endpoint; authorization is possession plus strict one-time refresh semantics, not object ID access. | Sensitive `private, no-store`. | `H-INV`, refresh race suites |
| `GET /openapi.json` | Public generated API description; no account state. | Public; no forced private header. | `H-INV`, public-policy test |
| `/docs` generated Swagger UI | Public static documentation surface; not an application resource/action. | Plugin/static policy. | route/plugin configuration |

## Protected HTTP matrix

Every row also carries `H-UNA`.

### Account, session, discovery, relationship and safety

| Surface | Actor and resource | Required relation/role | Expected denial and concealment | Evidence |
| --- | --- | --- | --- | --- |
| `GET /v1/auth/sessions` | Principal reads its device sessions. | Active session; account scope is derived only from token. | `401`; another account's session/token never appears. | `H-SCOPE`, `EXISTING` |
| `DELETE /v1/auth/sessions/current` | Principal revokes current session. | Active current session. | `401`; no caller-supplied object ID. | `EXISTING` |
| `DELETE /v1/auth/sessions/:id` | Principal revokes one of its sessions. | Target session must belong to principal account. | Foreign and random IDs are identical generic `404`; foreign session remains active. | `H-ORACLE`, `EXISTING` |
| `GET /v1/me` | Principal reads its own profile. | Active session; self derived from token. | `401`; no foreign account selector. | `H-SCOPE` |
| `GET /v1/users/search` | Principal searches known users. | Accepted current relationship plus privacy/block projection. | No unrelated/private account result; rate-limited. | `H-SCOPE`, `EXISTING` |
| `GET /v1/users/lookup` | Principal performs exact username lookup. | Target must be discoverable and not blocked; public-profile projection only. | Null/generic projection; no presence, last-seen, session, email or token. | `EXISTING` |
| `GET /v1/privacy` | Principal reads own privacy settings. | Self derived from token. | `401`; no account selector. | `H-SCOPE` |
| `PATCH /v1/privacy` | Principal changes own privacy settings. | Self derived from token; strict non-empty schema. | `401`/`400`; cannot select another account. | `H-UNA`, `EXISTING` |
| `POST /v1/message-requests` | Sender creates request to target account. | Existing target; target policy permits requests; neither direction blocked; no accepted/pending conflict. | Generic relationship `403` for private policy/block/cooldown; no target-only state leakage or partial event. | `EXISTING` |
| `GET /v1/message-requests` | Principal lists incoming or outgoing projection. | Participant direction derived from token and query enum. | Other accounts' body/profile/request IDs absent. | `H-SCOPE`, `EXISTING` |
| `POST /v1/message-requests/:id/accept` | Recipient accepts its pending request. | Principal must be exact recipient; still pending and unblocked. | Foreign/random identical generic `404`; no Direct/message/event created. | `H-ORACLE`, `EXISTING` |
| `DELETE /v1/message-requests/:id` | Recipient privately dismisses its pending request. | Principal must be exact recipient. | Foreign/random identical generic `404`; sender receives no dismiss reason/event. | `H-ORACLE`, `EXISTING` |
| `PUT /v1/blocks/:accountId` | Principal creates its own directed block edge. | Authenticated actor; existing non-self target. | `404` absent account, `409` self; target receives no block event. | `R-ACTOR`, `EXISTING` |
| `DELETE /v1/blocks/:accountId` | Principal removes its own directed block edge. | Actor owns edge namespace; idempotent when absent. | No target profile/state or implicit relationship restoration. | `R-ACTOR`, `EXISTING` |
| `GET /v1/blocks` | Principal lists own block edges/projections. | Self derived from token. | Other account's block graph absent. | `H-SCOPE`, `EXISTING` |
| `POST /v1/safety/reports` | Reporter submits private report about target. | Reporter must be a member of each selected message's chat; each evidence message must be authored by subject. | Generic unavailable evidence `404`; no report/block/audit/event on failure; subject gets no report event/content. | `R-ACTOR`, `EXISTING` |

### Chats, messages, pins, topics and receipts

| Surface | Actor and resource | Required relation/role | Expected denial and concealment | Evidence |
| --- | --- | --- | --- | --- |
| `GET /v1/chats` | Principal lists current memberships. | Current member; account scope in SQL. | Foreign chats and canaries absent. | `H-SCOPE` |
| `POST /v1/chats` | Principal creates Direct/group/channel. | Direct requires accepted unblocked relation; group/channel invitees must be accepted and unblocked; creator is owner. | Generic relationship `403`; atomic no-chat/no-event failure. | `H-DIRECT`, `EXISTING` |
| `GET /v1/chats/:id` | Member reads one chat projection. | Current membership. | Foreign/random identical generic `404`. | `H-ORACLE` |
| `GET /v1/chats/:id/messages` | Member reads chat history; optional topic must belong to chat. | Current membership. Historical Direct read remains after block. | Foreign/absent outer chat same `403`; cross-chat topic `404`; no content canary. | `H-SCOPE`, `H-NEST`, `H-DIRECT` |
| `POST /v1/chats/:id/messages` | Member posts message. | Current member; active Direct; channel owner/admin; owned attachments; reply/topic in same chat and topic open. | `403` relation/role/outsider; nested `404`; no nonce consumption/message/event. | `H-NEST`, `H-ROLE`, `H-DIRECT`, `EXISTING` |
| `PATCH /v1/messages/:messageId` | Author edits visible message. | Current member, exact author, active Direct. | Outsider/random identical `404`; visible non-author `403`; no version/search/event mutation. | `H-ORACLE`, `H-ROLE`, `H-DIRECT` |
| `DELETE /v1/messages/:messageId` | Author or group/channel owner/admin deletes. | Current member plus authorship or moderation role. Own Direct deletion is allowed after block. | Outsider/random identical `404`; visible non-author member `403`; no deletion/event. | `H-ORACLE`, `H-ROLE`, `H-DIRECT` |
| `GET /v1/messages/:messageId/history` | Member reads visible non-deleted history. | Current membership. Historical Direct read remains after block. | Outsider/random identical `404`; no body/version canary. | `H-ORACLE`, `H-DIRECT` |
| `POST /v1/messages/:messageId/forward` | Member forwards visible source into permitted target chat. | Source membership and accessible attachments; target membership/post role/active Direct; target topic in chat. | Hidden source `404`; target role/relation `403`; atomic no target message/event. | `H-ORACLE`, `H-ROLE`, `H-DIRECT`, `EXISTING` |
| `GET /v1/chats/:id/pins` | Member lists chat pins. | Current membership; historical Direct read remains after block. | Foreign/absent outer chat same `403`. | `H-SCOPE`, `H-DIRECT` |
| `PUT /v1/chats/:id/pins/:messageId` | Direct member or group/channel owner/admin pins same-chat message. | Membership, moderation role where non-Direct, active Direct, nested message. | Role/relationship `403`; missing/cross-chat/deleted message `404`; no pin/event. | `H-NEST`, `H-ROLE`, `H-DIRECT` |
| `DELETE /v1/chats/:id/pins/:messageId` | Same authority removes pin idempotently for a valid same-chat message. | Same as pin; message must belong to outer chat. | Role/relationship `403`; cross-chat message `404`, never silent success. | `H-NEST`, `H-ROLE`, `H-DIRECT` |
| `GET /v1/chats/:id/topics` | Member lists topics. | Current membership. | Foreign/absent outer chat same `403`. | `H-SCOPE` |
| `POST /v1/chats/:id/topics` | Member creates group topic; owner/admin creates channel topic. | Current member; Direct unsupported; channel moderation role. | Outsider/role `403`, Direct `409`; no topic/event. | `H-ROLE` |
| `PATCH /v1/topics/:id` | Owner/admin updates group/channel topic. | Current membership plus moderation role. | Outsider/random identical `404`; visible member lacking role `403`; no topic/event. | `H-ORACLE`, `H-ROLE` |
| `POST /v1/chats/:id/read` | Member advances own read position to same-chat message. | Current membership, active Direct, nested message. | Outer membership/relation `403`; cross-chat message `404`; no receipt/event. | `H-NEST`, `H-DIRECT`, `R-CMD` |
| `POST /v1/chats/:id/delivered` | Member records own delivery for same-chat message. | Current membership, active Direct, nested message. | Outer membership/relation `403`; cross-chat message `404`; no receipt/event. | `H-NEST`, `H-DIRECT`, `R-CMD` |
| `PUT /v1/messages/:messageId/reactions` | Member sets own reaction. | Message visibility, current membership, active Direct. | Outsider/random identical `404`; blocked Direct `403`; no reaction/event. | `H-ORACLE`, `H-DIRECT` |
| `DELETE /v1/messages/:messageId/reactions` | Member removes own reaction. | Same as reaction set. | Same concealment; no reaction/event. | `H-ORACLE`, `H-DIRECT` |
| `GET /v1/messages/:messageId/reactions` | Member reads aggregate projected for self. | Current membership. | Existing foreign/random identical generic `404`. | `H-ORACLE`, `EXISTING` |
| `GET /v1/messages/:messageId/receipts` | Member reads current-member receipts filtered for blocked actors. | Current membership. | Existing foreign/random identical generic `404`; blocked profile/actor absent. | `H-ORACLE`, `EXISTING` |

### Uploads, attachments, search and reconciliation

| Surface | Actor and resource | Required relation/role | Expected denial and concealment | Evidence |
| --- | --- | --- | --- | --- |
| `POST /v1/uploads` | Principal creates own reserved upload session. | Self-derived owner; quota/type/size/idempotency constraints. | `401`/bounded validation; cannot assign another owner. | `H-UNA`, `EXISTING` |
| `GET /v1/uploads/:id` | Upload owner reads session. | Exact owner account. | Existing foreign/random identical generic `404`. | `H-ORACLE`, `EXISTING` |
| `PUT /v1/uploads/:id/chunks/:index` | Upload owner writes exact chunk. | Exact owner plus active session/range/digest. Auth runs before buffering. | Existing foreign/random identical `404`; no staging/quota mutation. | `H-ORACLE`, `EXISTING` |
| `POST /v1/uploads/:id/complete` | Upload owner completes session. | Exact owner and complete validated chunks. | Existing foreign/random identical `404`; no attachment/event. | `H-ORACLE`, `EXISTING` |
| `GET /v1/attachments/:id/content` | Owner or user with current message-derived grant downloads. | Owner, or current chat membership; Direct grant additionally requires accepted unblocked relation. | Existing foreign/random identical generic `404`; no size/range/MIME/content leak. | `H-ORACLE`, `EXISTING` |
| `GET /v1/search/messages` | Principal searches only messages in current memberships; optional chat filter remains membership-scoped. | SQL account/chat membership predicates. | Foreign/absent chat yields no foreign result/content. | `H-SCOPE`, `EXISTING` |
| `GET /v1/search/files` | Principal searches owned or currently authorized linked attachments. | Same grant predicate as download. | Revoked/foreign files absent without metadata/snippet. | `H-SCOPE`, `EXISTING` |
| `GET /v1/attachments` | Principal rebuilds own uploaded attachment collection. | Owner ID derived from token. | Other owners' IDs/names absent. | `H-SCOPE`, `R-ACTOR` |
| `GET /v1/safety/reports` | Reporter rebuilds own report summaries. | Reporter ID derived from token. | Other reports, evidence and comments absent. | `H-SCOPE`, `EXISTING` |
| `GET /v2/sync/chats` | Principal rebuilds current chat memberships. | Account derived from active token/session. | Other account chats/content absent. | `H-SCOPE`, `EXISTING` |
| `GET /v2/sync/blocks` | Principal rebuilds own block edges. | Account derived from active token/session. | Other account block graph/profile snapshots absent. | `H-SCOPE`, `EXISTING` |
| `GET /v2/sync/snapshot` | Principal obtains account+device-session cursor boundary and resource map. | Active exact account/session. | Revoked session `401`; cursor cannot be reused by another account/session. | `H-SCOPE`, `EXISTING` |

## Realtime client-command matrix

The WebSocket upgrade itself is a public transport handshake subject to the
configured browser Origin allowlist and a process-local 16 pending-socket/IP
bound. It emits only `hello`; authentication is required within five seconds.
`/v1/realtime` and `/v2/realtime` share the command schema, active-session
recheck, authorization rules and the 60 authenticate-frame/IP/minute guard.

| Command | Required state/relation | Denial and side-effect policy | Evidence |
| --- | --- | --- | --- |
| `authenticate` | Valid access token with active matching account/session; only once per connection and at most four live sockets per device session. V1 numeric resume is V1-only; V2 cursor is account+session scoped. | Invalid/revoked `401` and close `4001`, no `ready`; duplicate `409`; local auth/session/pending overload returns `RATE_LIMITED` and closes `1013`; invalid/foreign cursor requires deterministic reconciliation and no dispatch. | `R-UNA`, `EXISTING`, realtime hostile-mix audit |
| `heartbeat` | Authenticated, active session and activated connection. | Pre-auth/revoked `401` + close; no ack or state/event. | `R-UNA`, `EXISTING` |
| `typing.start` | Current chat member; Direct must remain accepted and unblocked. Channel publish role is intentionally irrelevant to typing. | Outsider/blocked `403`; no peer event or durable state. | `R-UNA`, `R-CMD`, `R-DIRECT` |
| `typing.stop` | Same as `typing.start`; connection-local throttle applies after authorization. | Same denial; no peer event. | `R-UNA`, `R-CMD`, `R-DIRECT` |
| `receipt.delivered` | Current member, active Direct, message nested in supplied chat. | Foreign outer chat `403`; cross-chat message `404`; no receipt/durable event. | `R-UNA`, `R-CMD`, `R-DIRECT` |
| `receipt.read` | Same as delivered receipt. | Same denial and absence guarantees. | `R-UNA`, `R-CMD`, `R-DIRECT` |

## Durable realtime event matrix

V1 dispatch accepts the 12 messaging branches only. V2 accepts all 19 branches.
Every live/replayed chat event rechecks current chat membership; Direct chat
events additionally require a current accepted unblocked relation. Reaction
aggregates are reprojected for the viewer. Active device session is rechecked
before every delivery.

| Event branch | Authorized audience | Denied audience behavior | Evidence |
| --- | --- | --- | --- |
| `chat.created` | Current chat member. | Outsider and removed/blocked Direct audience filtered. | `R-CHAT` |
| `message.created` | Current chat member and active Direct relation. | No message ID/body/attachments to outsider. | `R-CHAT`, `EXISTING` |
| `message.updated` | Same as message created. | No updated body/version to outsider. | `R-CHAT` |
| `message.deleted` | Same chat authorization; tombstone contains only authorized projection. | Outsider filtered. | `R-CHAT` |
| `attachment.stored` | Exact attachment owner account selected by producer. | No non-owner event; no ID/file metadata. | `R-ACTOR`, `EXISTING` |
| `message.pinned` | Current chat member and active Direct relation. | Outsider filtered. | `R-CHAT` |
| `message.unpinned` | Current chat member and active Direct relation. | Outsider filtered. | `R-CHAT` |
| `topic.created` | Current chat member. | Outsider filtered. | `R-CHAT` |
| `topic.updated` | Current chat member. | Outsider filtered. | `R-CHAT` |
| `receipt.delivered` | Current chat member; blocked group actors filtered for viewer. | Outsider/blocked actor event filtered. | `R-CHAT`, `EXISTING` |
| `receipt.read` | Same as delivered. | Same filtering. | `R-CHAT`, `EXISTING` |
| `reaction.updated` | Current chat member; actor must not be blocked unless self; aggregate reprojected. | Outsider/blocked actor and reaction canary filtered. | `R-CHAT`, `EXISTING` |
| `relationship.request.created:sender_account` | Exact sender account, sender-safe projection. | No unrelated audience; no recipient-private state. | `R-ACTOR`, `EXISTING` |
| `relationship.request.created:recipient_account` | Exact current recipient while request is pending and unblocked. | Sender/unrelated audience cannot receive recipient projection. | `R-ACTOR`, `EXISTING` |
| `relationship.request.removed:recipient_account` | Exact recipient account synchronizing private removal. | Sender receives no dismiss/block reason. | `R-ACTOR`, `EXISTING` |
| `relationship.request.accepted:participant_account` | Sender and recipient while accepted relation/chat remain current. | Unrelated/blocked audience filtered. | `R-ACTOR`, `EXISTING` |
| `relationship.request.expired:participant_account` | Original sender and recipient while not blocked. | Unrelated/blocked audience filtered. | `R-ACTOR` |
| `relationship.block.changed:actor_account` | Blocking/unblocking actor account only. | Target receives no block signal/profile/event. | `R-ACTOR`, `EXISTING` |
| `safety.report.submitted:actor_account` | Reporter account only; summary excludes comment/evidence content. | Subject/unrelated account receives no report event. | `R-ACTOR`, `EXISTING` |

Ephemeral `typing.updated` is sent only to current chat members not blocked by the
actor and never to the originating connection. `presence.updated` is sent only
to accepted, unblocked peer accounts. `hello`, `ready`, `sync.checkpoint`,
`heartbeat`, `heartbeat.ack`, `sync.required`, and `error` are connection/control
messages, not cross-account resources; their token/session/cursor boundaries are
covered by `R-UNA`, cursor tests and reconciliation tests.

## Remediated findings from this matrix

Severity describes the pre-fix boundary.

| Severity | Finding | Remediation |
| --- | --- | --- |
| Medium | Existing foreign message edit/delete/history/forward/reaction and topic update returned `403`, while a random UUID returned `404`, exposing private object existence. | Lookup now verifies visibility before returning role/authorship denial. Outsider/random pairs are identical `404`; a legitimate member lacking author/admin rights still receives intentional `403`. |
| Medium | Cross-chat `DELETE /v1/chats/:id/pins/:messageId` silently returned `204` because unpin did not validate that the nested message belonged to the outer chat. | Unpin now validates same-chat, non-deleted message before idempotent pin removal; wrong-chat IDs return `404` with no event/state change. |
| Low | The private cache hook omitted `/v1/me`, exact `/v1/chats`, uploads and search families on both success and error responses. | All protected or credential-bearing `/v1/*` responses and every `/v2/sync/*` response are private/no-store. The account-free capabilities contract has explicit public `no-store`/`no-cache`; health, metrics and OpenAPI remain outside the hook. |

## Verification

Focused matrix command:

```bash
npm --prefix services/api test -- --run \
  src/authorization-matrix.integration.test.ts \
  src/authorization-realtime-matrix.integration.test.ts
```

The checkpoint focused result is 2 files / 14 tests. The final combined API gate
passed production typecheck, test typecheck, all 28 files / 168 tests, and the
production TypeScript build.

## Honest residual gaps

1. This covers only current routes/events. Future membership removal, role
   mutation, moderation/admin, calls, passkeys, push, account lifecycle and
   deletion endpoints must add new rows and hostile probes before merge.
2. Current reconciliation page cursors are bounded but not signed or bound to
   account/resource. SQL ownership predicates prevent tested cross-account reads;
   authenticated page cursors remain a production robustness gate.
3. Group/channel membership is fixture-created because public membership/role
   mutation endpoints do not exist. The matrix proves current action BFLA but
   cannot prove immediate removal or role-change propagation for absent features.
4. The durable event database and producer transactions are trusted integrity
   boundaries. Delivery rechecks current account/chat authorization, but a full
   tamper-evident event-log design remains separate.
5. Distributed deployment, DAST through the real ingress/proxy, cache/protocol
   smuggling, multi-process abuse coordination and production data-scale testing
   remain later gates.
