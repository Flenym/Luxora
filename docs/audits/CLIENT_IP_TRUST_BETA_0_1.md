# Client-IP trust checkpoint — Beta-0.1

Owner and developer: Flenym  
Checkpoint: 2026-08-04  
Scope: HTTP and WebSocket abuse-bucket IP provenance in the current single API
process.

## Finding and decision

The old optional `TRUST_PROXY=true` setting delegated `request.ip` to an
unbounded trusted chain. In that mode Fastify may use `X-Forwarded-For`, so a
deployment that appends without a correctly anchored trust boundary can let a
client choose the global HTTP, pending-socket or authentication-attempt bucket.
Raw textual IPs also left equivalent IPv6 and IPv4-mapped forms as potentially
different local map keys.

Luxora no longer permits boolean trust-all or hop-count trust. Direct mode is
the default and ignores forwarding headers. A proxied deployment must set
`TRUSTED_PROXY_CIDRS` to an explicit comma-separated list of the actual proxy
source networks. Catch-all `/0`, implicit prefixes, scoped addresses,
IPv4-mapped IPv6 proxy notation, duplicates and malformed/oversized lists fail
startup. Fastify walks from the socket peer toward the client and stops at the
first address outside that allowlist; attacker-prepended values farther left do
not select the bucket.

This follows Fastify's documented model: `trustProxy=false` uses the socket,
while explicit IP/CIDR values define which proxies may supply forwarded
metadata. Fastify also warns that `request.ip` remains untrusted input for
security decisions, so Luxora validates and normalizes it before use:

- [Fastify server `trustProxy`](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)
- [Fastify request IP security note](https://fastify.dev/docs/latest/Reference/Request/#request)

## Canonical policy and bounded anonymous derivation

`clientIpBucketKey()` is the sole key boundary for both the global HTTP limiter
and realtime `/v1` plus `/v2` pending/authentication guards:

- strict IPv4 becomes `ipv4:a.b.c.d`;
- IPv4-mapped IPv6 collapses to the same IPv4 key;
- IPv6 is lower-case and RFC-style compressed through Node's validated URL/IP
  primitives; interface scope is removed so alternate local spellings cannot
  rotate buckets;
- invalid or non-string values collapse to the constant `ip:unresolved`, never
  to attacker text.

The configured proxy list anchors provenance; canonicalization only prevents
representation-based bucket rotation and does not make a forwarded header
trustworthy by itself.

The internal identifier-free passkey-login routes derive a separate
domain-labelled key with `anonymousPasskeyIpBucketKey()`. Canonical IPv4 stays
exact (including IPv4-mapped aliases), while canonical IPv6 is reduced to its
first 64 bits. This prevents one subscriber who controls address selection
inside a delegated `/64` from obtaining a new local anonymous-intent allowance
for every low-64-bit rotation. Invalid inputs collapse to the constant
`passkey-login:v1:ip:unresolved`; neither URL/query data nor raw attacker text
enters the key. This derivation consumes Fastify's already-resolved
`request.ip`, so it does not alter the trusted-proxy boundary.

## Executable hostile evidence

`client-ip-security.integration.test.ts`, `config.test.ts` and
`realtime-hostile-mix.integration.test.ts` prove:

1. direct mode ignores rotating `X-Forwarded-For` values;
2. an untrusted direct peer cannot activate forwarding-header trust;
3. an explicit multi-hop allowlist selects the closest untrusted address and
   ignores attacker-prepended values;
4. distinct actual clients behind trusted proxies retain distinct HTTP keys;
5. expanded/compressed IPv6 and IPv4/IPv4-mapped representations share keys;
6. malformed forwarded values share one fail-closed bucket and never become
   attacker-selected map/bucket keys;
7. trust-all, `/0` and ambiguous proxy configuration fail startup;
8. the 60-attempt realtime authentication limit is shared across V1/V2 even
   when the attacker alternates IPv6 spelling and prepended forwarding values;
9. ten malformed passkey-options requests spread across one IPv6 `/64` exhaust
   one route allowance, while a different `/64` remains independent.

The focused gate passed production/test typecheck and 3 files / 34 tests. The
final combined API gate passed production/test typecheck, all 28 files / 168
tests, and the production TypeScript build.

## Deployment contract and residual risk

The API must be unreachable except from the listed ingress/proxy sources. The
public edge must remove any client-supplied forwarding header and write the
actual peer address; every additional listed proxy must append its observed
peer in a documented, tested order. A direct bypass, overly broad private CIDR,
misconfigured managed ingress, PROXY protocol path or alternate load-balancer
route can still corrupt provenance and requires deployment-level evidence.

IP limits are deliberately coarse. Users behind NAT, carrier NAT, an enterprise
egress or a privacy relay share unauthenticated/reconnect capacity and can cause
false positives. Increasing thresholds or adding risk/device/account signals
requires measured abuse and availability evidence; accepting a client-selected
identifier is not a remedy.

All current counters remain fixed-window and process-local. They reset on
restart and do not coordinate across replicas. This checkpoint does not claim a
distributed/global rate limiter, production ingress proof, DDoS protection or
capacity validation. In particular, `/64` aggregation does not stop rotation
across delegated networks and does not provide durable-intent admission,
backpressure or retention. Those remain public-passkey release gates.
