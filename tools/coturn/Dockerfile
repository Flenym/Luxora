# Local-development TURN relay for the Luxora calls harness.
#
# Internal-only tooling: never shipped to users. It is built locally instead of
# consuming an upstream coturn runtime image because the published
# `coturn/coturn:*-alpine3.24` tags are built on an Alpine base that still ships
# `brotli-libs 1.2.0-r1` (CVE-2026-111497, fixed in 1.2.1-r0), which the
# security gate reports as CRITICAL. Building from the current pinned Alpine
# base keeps the relay on a patched base image while the upstream tags catch up.
#
# syntax=docker/dockerfile:1

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

# bash: the upstream coturn entrypoint/healthcheck helpers use bash; the base
# runtime arguments are supplied by docker-compose.calls.yml. The Alpine
# community package is 4.10.0 without the newer Prometheus metrics endpoint,
# so the harness exposes only the TURN listener; LiveKit's metrics remain the
# media-plane metric source.
RUN apk add --no-cache --no-progress coturn bash \
    && addgroup -S turn 2>/dev/null || true \
    && adduser -S -G turn turn 2>/dev/null || true

EXPOSE 3478 3478/udp

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
    CMD bash -ec 'exec 3<>/dev/tcp/127.0.0.1/3478; exec 3>&-'

ENTRYPOINT ["turnserver"]
