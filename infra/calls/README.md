# Luxora calls infrastructure harness

**Public release:** Beta-0.1  
**Owner and developer:** Flenym

This directory is a local, loopback-only SFU/TURN configuration probe. It does
not implement Luxora call records, authorization, invitations, ringing,
membership epochs, call tokens, push, screen sharing, media E2EE, or a client.
No surface may describe calls as working because these containers start.

The pinned components are:

- LiveKit Server `v1.13.5` as the SFU and WebRTC signaling/media transport;
- coturn `4.16.0` on the official Alpine 3.24 image as the TURN relay using
  time-limited REST credentials;
- image index digests recorded in `docker-compose.calls.yml` for reproducible
  multi-architecture resolution.

## Validate configuration

```bash
cp infra/calls/environment.example infra/calls/.env.calls
# Replace both placeholder secrets, for example with independent output from:
# openssl rand -base64 48 | tr '+/' '-_' | tr -d '='

docker compose \
  --env-file infra/calls/.env.calls \
  -f docker-compose.calls.yml \
  config --quiet
```

## Start the local probe

```bash
docker compose \
  --env-file infra/calls/.env.calls \
  -f docker-compose.calls.yml \
  up --detach

curl --fail http://127.0.0.1:6789/metrics >/dev/null
curl --fail http://127.0.0.1:9641/metrics >/dev/null
```

For a disposable end-to-end infrastructure probe, run:

```bash
infra/calls/smoke.sh
```

The smoke script keeps independent random credentials in its own process,
uses a unique Compose project, waits for both healthchecks, verifies both
metrics endpoints, proves that coturn accepts a REST credential derived from
the configured secret and rejects one derived from a wrong secret, and then
removes only its own containers/network. This is allocation/authentication
evidence—not a media-quality or Luxora call-control test.

The API/signaling endpoint is bound to `127.0.0.1:7880`; TURN is bound to
loopback on port `3478`; metrics are loopback-only. The small relay range is a
test constraint, not production capacity. UDP/TCP TURN is intentionally
unencrypted only on this same-machine harness. Production requires public DNS,
TLS/TURN-TLS, real public IP mapping, firewall/L4 configuration, multiple
failure domains, capacity evidence, secret management, abuse controls, and no
loopback port publishing.

Stop without deleting unrelated Docker state:

```bash
docker compose \
  --env-file infra/calls/.env.calls \
  -f docker-compose.calls.yml \
  down
```

Canonical control-plane and release gates are defined in
[`docs/specs/CALLS_PLATFORM.md`](../../docs/specs/CALLS_PLATFORM.md).
