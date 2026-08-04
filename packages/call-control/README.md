# Luxora call-control domain

Owner/developer: **Flenym**. Canonical release label: **Beta-0.1**.

This isolated package is a deterministic server-domain foundation. It does not
make calls available and is not connected to `services/api`, LiveKit, coturn,
push notifications, webhooks or a client.

Implemented here:

- a versioned 1:1, group and scheduled-call aggregate;
- explicit revision-checked lifecycle transitions and immutable `ended` state;
- per-device membership plus call and membership security epochs;
- caller/device/session-scoped command idempotency and create nonces;
- atomic snapshot/event/outbox/receipt persistence contracts;
- receipt replay that remains deterministic whether a store checks CAS or
  unique receipts first;
- accept/hangup and kick/rejoin race resolution by compare-and-swap revision;
- a 366-day scheduling horizon and system-only generic terminal reasons;
- two-minute, room/source-scoped LiveKit descriptors and five-minute coturn
  REST credentials through injected secret-owning signers;
- canonical participant plus authenticated membership/member/device binding
  before either signer is invoked;
- outbox audiences containing only currently routable, non-terminal
  memberships (removed records stay in the internal event history only);
- bounded metadata and identifiers, with no media, SDP, ICE material, secrets
  or media-encryption keys in aggregate events.

The official LiveKit grant fields used by the descriptor are documented in
[Tokens & grants](https://docs.livekit.io/frontends/reference/tokens-grants/). Coturn
REST usernames and HMAC-SHA1 credentials follow the canonical
[coturn server documentation](https://github.com/coturn/coturn/blob/master/README.turnserver).
The TURN username assumes coturn's documented default `:` REST separator and
uses `expiry-unix-seconds:opaque-participant.grant-id`; signer output must be
the standard 28-character Base64 encoding of an HMAC-SHA1 digest. Production
issuer and relay clocks must be NTP-synchronized.

The embedding service still must provide current conversation/block/request,
device-session and abuse authorization; an official LiveKit SDK signer;
authenticated webhook reconciliation; SFU eviction on epoch changes; push and
ringing delivery; production storage; quotas; network/load/security labs; and
the separately audited media-E2EE program.

The embedding service must authenticate the request and construct the actor
and authorization subject itself **before** calling the executor or grant
issuer. Client-supplied actor/session or authorization fields are never
trusted. The package rejects a participant object that differs from the
canonical aggregate record, but it does not query identity or membership
storage itself.

For self-hosted LiveKit, token expiry limits new joins/rejoins but does not end
an already connected session. Every epoch-changing transition therefore still
requires the embedding service to evict affected SFU participants and deny
fresh grants. A signer is also a privileged adapter: it must encode exactly the
descriptor and must not add grants, room configuration, SIP claims or longer
validity.

For the current JavaScript server SDK adapter, pass `descriptor.ttlSeconds` as
the numeric `AccessToken` `ttl`, map the four source strings to the SDK's
`TrackSource` enum, set only identity/metadata plus `videoGrant`, and let the
SDK set JWT `nbf`. Never pass the millisecond audit timestamps as JWT seconds.
