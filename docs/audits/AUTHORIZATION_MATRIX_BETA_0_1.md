# Luxora HTTP and realtime authorization matrix — Beta-0.1

Owner: Flenym  
Checkpoint: 2026-08-11
Scope: every explicitly registered current HTTP resource/action, both current
WebSocket endpoints, every current client command, and every current durable
event audience branch.

## Claim boundary

This is an executable matrix for the routes and schemas that exist now. It does
not claim coverage for future ownership transfer/invitation approval, moderation, calls, passkeys,
APNs delivery, export/deletion, administration, or E2EE surfaces because those endpoints
do not exist. A source-inventory assertion fails when an explicit HTTP route,
dynamic realtime path, client command variant, or durable event branch is added
without updating the matrix.

Evidence labels below map to named tests:

- `H-INV`: explicit route-source inventory equals the public-policy list plus all
  71 protected HTTP rows: 84 explicit routes total with 13 classified public.
- `H-UNA`: invalid authentication is table-tested on all 71 protected rows;
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
- `R-INV`: both dynamic WS paths, six client commands and 23 durable audience
  branches are source-inventoried.
- `R-UNA`: every non-auth command and invalid authentication are denied on both
  protocols before ready/state change.
- `R-CMD`: foreign/cross-chat commands, group/channel membership, allowed typing
  and receipts, response canaries, and event absence.
- `R-DIRECT`: blocked Direct typing/receipt denial with no peer event or durable
  side effect.
- `R-CHAT`: all 11 chat-scoped durable events are delivered to a current member
  and filtered for an outsider.
- `R-ACTOR`: attachment-owner, private chat-preference/folder accounts and all
  seven identity/audience branches are produced and replayed only for their
  intended accounts.
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
| `POST /v1/auth/phone/challenges` | Unauthenticated development/external-provider phone challenge bootstrap with strict E.164 input, replay nonce and resend/rate controls; feature remains default-off. | Sensitive `private, no-store`; response never contains the code. | `H-INV`, phone-auth suites |
| `POST /v1/auth/phone/challenges/:id/verify` | Challenge possession plus correct OTP and exact command nonce; account lookup occurs only after code verification. | Sensitive `private, no-store`; bounded invalid/expired/exhausted outcomes reveal no account existence. | `H-INV`, phone-auth suites |
| `POST /v1/auth/phone/password` | Possession of a short-lived post-OTP continuation plus the enabled account phone password and exact nonce. | Sensitive `private, no-store`; separate Argon2id hash/flag cannot enable username-only login, bounded durable failures, terminal grant lock and encrypted exact response replay. | `H-INV`, phone-password suites |
| `POST /v1/auth/phone/registrations` | Short-lived verified registration grant creates the phone account/session exactly once. | Sensitive `private, no-store`; exact response-loss replay only. | `H-INV`, phone-auth suites |
| `POST /v1/auth/phone/usernames/check` | Short-lived verified registration grant checks a normalized candidate and bounded alternatives before account creation. | Sensitive `private, no-store`; no unrelated private-profile projection. | `H-INV`, phone-auth suites |
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
| `PATCH /v1/me` | Principal updates only its own display name and/or bio. | Active session; self derived from token; strict non-empty bounded schema. | `401`/`400`; no account selector or arbitrary avatar URL; no foreign mutation. | `H-UNA`, profile-update suite |
| `PUT /v1/me/avatar` | Principal creates and binds a processed derivative from one uploaded image. | Source attachment is active, exact owner and verified image; server bounds bytes/pixels, decodes, strips metadata, crops/re-encodes, then quota-checks and binds under the writer lock. | Foreign/random source is generic `404`; invalid media/quota fails without avatar row or retained output object; arbitrary URL is not accepted. | `H-UNA`, profile-avatar suite |
| `DELETE /v1/me/avatar` | Principal clears only its own current processed derivative. | Active session; self derived from token. | `401`; previous derivative becomes unlinked for retention cleanup without exposing another account selector. | `H-UNA`, profile-avatar suite |
| `GET /v1/me/phone-password` | Principal reads whether its verified phone account has the optional second password enabled. | Active session; self derived from token; legacy accounts without phone binding are ineligible. | `401`; no phone number, hash or foreign selector. | `H-SCOPE`, phone-password suite |
| `PUT /v1/me/phone-password` | Principal enables or changes its own post-OTP password. | Verified phone binding; an existing password must be supplied before CAS replacement. | `401`/`409`; no account selector, raw password response or cross-account mutation. | `H-UNA`, phone-password suite |
| `DELETE /v1/me/phone-password` | Principal disables its own post-OTP password. | Verified phone binding plus current password; CAS replaces the hash with a fresh discarded-secret Argon2id placeholder. | `401`/`409`; concurrent changes fail closed. | `H-UNA`, phone-password suite |
| `GET /v1/push/registrations/current` | Principal reads the token-free projection for its current session. | Active session; account and session derive only from the bearer. | `401`; no raw token or caller-supplied account/session selector. | `H-SCOPE`, push-notification suite |
| `PUT /v1/push/registrations/current` | Principal binds one APNs token to its current session. | Strict APNs/environment input; server-fixed app topic; token transfer/rotation is atomic and encrypted. | `401`/`400`; another account cannot be selected and no token is returned. | `H-UNA`, push-notification suite |
| `DELETE /v1/push/registrations/current` | Principal idempotently revokes its current push row. | Active current session; self derived from token. | `401`; no foreign registration ID/token oracle. | `H-UNA`, push-notification suite |
| `GET /v1/notifications/settings` | Principal reads its synchronized global notification preferences. | Self derived from token; hidden preview is the privacy default. | `401`; no account selector. | `H-SCOPE`, push-notification suite |
| `PATCH /v1/notifications/settings` | Principal changes a strict non-empty subset of its own preferences. | Self derived from token. | `401`/`400`; no cross-account mutation or unknown fields. | `H-UNA`, push-notification suite |
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

### Chat folders, chats, messages, pins, topics and receipts

| Surface | Actor and resource | Required relation/role | Expected denial and concealment | Evidence |
| --- | --- | --- | --- | --- |
| `GET /v1/chat-folders` | Principal lists only its synchronized custom folders and account state revision. | Account ID derives from the bearer; no caller-supplied account selector. | Another account's titles/chat IDs/folder IDs are absent. | `H-SCOPE`, folder API/storage suites |
| `POST /v1/chat-folders` | Principal creates one folder under its own account with an actor-scoped exact nonce. | Strict bounded rules/overrides; every override chat requires current membership; 10-folder/100-override bounds. | `401`/`400`/`409`; no foreign chat oracle, partial folder, receipt or event. | `H-UNA`, `R-ACTOR`, folder API/storage suites |
| `PUT /v1/chat-folders/order` | Principal replaces its own complete folder order. | Non-empty unique list must be the exact current account folder-ID set and `expectedStateRevision` must match the atomic snapshot. | Stale revision or changed/foreign/incomplete set is generic `409`; two-device reorder race has one winner; semantic no-op creates no state/event change. | `H-UNA`, `R-ACTOR`, folder API/storage/race suites |
| `PATCH /v1/chat-folders/:id` | Principal changes title/rules/overrides of one owned folder under `expectedRevision`. | Folder account ownership; strict non-empty mutable patch; position is not patchable. | Foreign/random folder is the same generic `404`; stale revision `409`; normalized no-op preserves revisions/event sequence. | `H-UNA`, folder API/storage suites |
| `DELETE /v1/chat-folders/:id` | Principal deletes one owned folder under `expectedRevision`; remaining positions normalize. | Folder account ownership and exact revision. | Foreign/random folder is generic `404`; stale revision `409`; no cross-account delete. | `H-UNA`, `R-ACTOR`, folder API/storage suites |
| `GET /v1/chats` | Principal lists current memberships. | Current member; account scope in SQL. | Foreign chats and canaries absent. | `H-SCOPE` |
| `POST /v1/chats` | Principal creates Direct/group/channel. | Direct requires accepted unblocked relation; group/channel invitees must be accepted and unblocked; creator is owner. | Generic relationship `403`; atomic no-chat/no-event failure. | `H-DIRECT`, `EXISTING` |
| `GET /v1/chats/:id` | Member reads one chat projection. | Current membership. | Foreign/random identical generic `404`. | `H-ORACLE` |
| `GET /v1/chats/:id/preferences` | Member reads only its own archive/mute state for one chat. | Current membership; account scope derives from the bearer and membership row. | Foreign/absent outer chat uses the generic membership denial; no other member preference state appears. | `H-UNA`, chat-preferences suite |
| `PATCH /v1/chats/:id/preferences` | Member changes a strict non-empty subset of only its own archive/mute state. | Current membership; desired-state archive is idempotent and independent columns update atomically. | `401`/`403`/`400`; no other member selector, unknown field or cross-account mutation. | `H-UNA`, chat-preferences suite |
| `GET /v1/chats/:id/members` | Member lists the current bounded membership projection. | Current membership. | Foreign/absent outer chat same generic membership denial; no unrelated graph. | `H-SCOPE`, `EXISTING` |
| `POST /v1/chats/:id/members` | Group/channel owner/admin adds an accepted, unblocked account with an actor-scoped idempotency nonce. | Current moderation role; Direct immutable; 200-member bound. | Role/relation denial; no membership/event/nonce side effect. | `H-ROLE`, `EXISTING` |
| `PATCH /v1/chats/:id/members/:userId` | Group/channel owner/admin changes a mutable member/admin role with expected revision. | Current moderation role; sole owner immutable. | Foreign/random target concealed; stale revision conflicts without mutation/event. | `H-ROLE`, `H-ORACLE`, `EXISTING` |
| `DELETE /v1/chats/:id/members/:userId` | Group/channel owner/admin removes a non-owner member with expected revision. | Current moderation role; Direct and sole owner immutable; affected overrides owned by the removed account are reconciled atomically. | Role/oracle/revision denial; removed member loses future access immediately and no stale override survives. | `H-ROLE`, `H-ORACLE`, folder API/storage suites, `EXISTING` |
| `POST /v1/chats/:id/invite-links` | Group/channel owner/admin mints a bearer invite link with optional expiry/max-uses. | Current moderation role; Direct unsupported. Raw token returned once, stored as digest only. | Role denial; reused creation nonce `409` with `invite_token_shown_once` (token is never reshown). | `H-ROLE`, invite-links suite |
| `GET /v1/chats/:id/invite-links` | Owner/admin lists metadata-only link projections. | Current moderation role. | Role denial; no token material in any projection. | `H-ROLE`, invite-links suite |
| `DELETE /v1/chats/:id/invite-links/:linkId` | Owner/admin revokes a link idempotently. | Current moderation role; link must belong to the chat. | Cross-chat/unknown link generic `404`. | `H-ROLE`, `H-ORACLE`, invite-links suite |
| `POST /v1/invite-links/join` | Any authenticated account joins a group/channel by bearer token. | Link live (not revoked/expired/exhausted); 200-member bound; existing members return idempotent success. | Unknown token generic `404`; dead link `404` with `revoked`/`expired`/`exhausted` reason; nonce reuse across links `409`. | `H-ORACLE`, invite-links suite |
| `GET /v1/chats/:id/join-requests` | Owner/admin lists pending/decided join requests for one chat. | Current moderation role. | Role denial; no cross-chat visibility. | `H-ROLE`, join-requests suite |
| `POST /v1/chats/:id/join-requests/:requestId/approve` | Owner/admin admits a pending request with membership + events. | Current moderation role; request pending in this chat; link live; 200-member bound. | Foreign/decided requests replay current state; dead link `404` with link reason, request stays pending. | `H-ROLE`, `H-ORACLE`, join-requests suite |
| `POST /v1/chats/:id/join-requests/:requestId/deny` | Owner/admin rejects a pending request without membership. | Current moderation role; request pending in this chat. | Foreign requests generic `404`; denied requesters may re-file. | `H-ROLE`, `H-ORACLE`, join-requests suite |
| `POST /v1/chats/:id/ownership-transfers` | Sole owner opens a 24-hour transfer to one current member. | Owner role; non-Direct; single pending ceremony per chat. | Non-owner `403`; self/owner-target/direct `409`; reused nonce exact replay or `409`. | `H-ROLE`, transfer suite |
| `GET /v1/chats/:id/ownership-transfers` | Managers and the designated successor view the pending ceremony. | Current membership plus manager-or-successor scope. | Outsider `403`; no pending ceremony returns null transfer. | `H-SCOPE`, transfer suite |
| `POST /v1/chats/:id/ownership-transfers/:transferId/accept` | Designated successor atomically takes ownership; previous owner becomes admin. | Pending ceremony; successor identity; atomic role swap with revision bumps. | Foreign/decided ceremonies replay; intruder `403`; expired `404` with reason. | `H-ROLE`, `H-ORACLE`, transfer suite |
| `POST /v1/chats/:id/ownership-transfers/:transferId/cancel` | Initiating owner aborts a pending ceremony. | Owner role plus initiator identity. | Non-initiator `403`; decided ceremonies replay. | `H-ROLE`, transfer suite |
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
| `GET /v1/attachments/:id/content` | Owner or user with a current message/profile-derived grant downloads. | Owner; current chat membership (Direct additionally accepted/unblocked); or currently bound avatar that is discoverable/shared-chat and unblocked. | Existing foreign/random identical generic `404`; clear/privacy/block revokes the avatar-derived grant; no size/range/MIME/content leak. | `H-ORACLE`, `EXISTING`, profile-avatar suite |
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

V1 dispatch accepts the 12 messaging branches only. V2 accepts all 23 audience
branches.
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
| `chat.member.changed:member_account` | Every current chat member after add, role update or removal. | A removed/foreign account cannot receive the current-member projection. | `R-INV`, `EXISTING` |
| `chat.member.changed:removed_account` | Exact removed account, only after its membership row is gone. | Current/foreign accounts cannot receive this projection; older queued chat events fail membership recheck. | `R-INV`, `EXISTING` |
| `chat.preferences.updated:member_account` | Exact account whose own archive/mute row changed, while it remains a member. | Another current member and every outsider are filtered; replaying the same desired state emits no event. | `R-ACTOR`, chat-preferences suite |
| `chat.folders.updated:actor_account` | Exact account whose global folder state changed, including cleanup after its chat membership is removed. | A different account is filtered even when the stored outbox audience is synthetically misaddressed; exact replay remains account-bound and semantic no-ops emit nothing. | `R-INV`, `R-ACTOR`, folder API/storage suites |
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

The current folder checkpoint results are: shared protocol 10 files / 83 tests;
folder API plus direct storage 2 files / 11 tests; and these HTTP/realtime
matrices 2 files / 14 tests in Docker Node 22. The focused matrix test typecheck
also passes. No full merged API-suite result is claimed here until its separate
post-folder run completes.

## Honest residual gaps

1. This covers only current routes/events. Future ownership transfer, invitation
   approval/join links, broader moderation/admin, calls, passkeys, APNs delivery, account lifecycle and
   deletion endpoints must add new rows and hostile probes before merge.
2. Current reconciliation page cursors are bounded but not signed or bound to
   account/resource. SQL ownership predicates prevent tested cross-account reads;
   authenticated page cursors remain a production robustness gate.
3. Group/channel list/add/role/remove routes now have executable authorization,
   idempotency and independent-writer evidence. Ownership transfer, invitation
   approval/privacy and production-database removal/role fault injection remain open.
4. The durable event database and producer transactions are trusted integrity
   boundaries. Delivery rechecks current account/chat authorization, but a full
   tamper-evident event-log design remains separate.
5. Distributed deployment, DAST through the real ingress/proxy, cache/protocol
   smuggling, multi-process abuse coordination and production data-scale testing
   remain later gates.
