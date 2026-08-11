#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root_config=$(mktemp /tmp/luxora-root-compose.XXXXXX)
calls_config=$(mktemp /tmp/luxora-calls-compose.XXXXXX)

cleanup() {
  rm -f "$root_config" "$calls_config"
}
trap cleanup EXIT

cd "$repo_root"
LUXORA_ENV_FILE=.env.example docker compose \
  --env-file .env.example \
  --profile observability \
  --profile development \
  config --format json >"$root_config"
docker compose \
  --env-file infra/calls/environment.example \
  --file docker-compose.calls.yml \
  config --format json >"$calls_config"

jq --exit-status '
  .services.api as $api
  | .services.prometheus as $prom
  | .services["otp-console"] as $otp
  | ($api.read_only == true)
    and ($api.cap_drop == ["ALL"])
    and (($api.security_opt | index("no-new-privileges:true")) != null)
    and ($api.environment.HOST == "0.0.0.0")
    and ($api.environment.PORT == "8080")
    and (($api.ports | length) > 0)
    and all($api.ports[]; .host_ip == "127.0.0.1")
    and ($api.healthcheck.test[0] == "CMD")
    and ($api.healthcheck.test[1] == "/nodejs/bin/node")
    and ($prom.image == "prom/prometheus:v3.13.2-distroless@sha256:64f71bb84e03c855948418b0fc5dea53e9543d8e3fc9931598f583805507f05e")
    and ($prom.read_only == true)
    and ($prom.cap_drop == ["ALL"])
    and (($prom.security_opt | index("no-new-privileges:true")) != null)
    and (($prom.ports | length) > 0)
    and all($prom.ports[]; .host_ip == "127.0.0.1")
    and ($prom.healthcheck.test[1] == "/bin/promtool")
    and (($prom.command | index("--web.enable-lifecycle")) == null)
    and ($otp.profiles == ["development"])
    and ($otp.read_only == true)
    and ($otp.cap_drop == ["ALL"])
    and (($otp.security_opt | index("no-new-privileges:true")) != null)
    and ($otp.environment.NODE_ENV == "development")
    and ($otp.environment.LUXORA_LOCAL_OTP_CONSOLE == "enabled")
    and (($otp.environment | keys | sort) == [
      "LUXORA_LOCAL_OTP_CONSOLE",
      "LUXORA_OTP_CONSOLE_PUBLIC_PORT",
      "NODE_ENV",
      "PHONE_AUTH_DEVELOPMENT_CODE",
      "PHONE_AUTH_PROVIDER",
      "PORT"
    ])
    and (($otp.ports | length) == 1)
    and all($otp.ports[]; .host_ip == "127.0.0.1")
    and ($otp.healthcheck.test[0] == "CMD")
    and ($otp.healthcheck.test[1] == "/nodejs/bin/node")
    and ($otp.networks["developer-tools"] == null)
    and (.networks.observability.internal == true)
' "$root_config" >/dev/null || {
  echo "Root Compose security invariants failed." >&2
  exit 1
}

jq --exit-status '
  .services.sfu as $sfu
  | .services.turn as $turn
  | ($sfu.image == "livekit/livekit-server:v1.13.5@sha256:3497163e15c48fef6e7830c78716f9e9d5edc28abf7aa90b61c86e93bbc306b1")
    and ($turn.image == "coturn/coturn:4.16.0-alpine3.24@sha256:901954a6b057079e1b12b2e4b4de06e3419e503336ba76c18f62debca3ac4b42")
    and ($sfu.read_only == true)
    and ($turn.read_only == true)
    and ($sfu.cap_drop == ["ALL"])
    and ($turn.cap_drop == ["ALL"])
    and ($turn.cap_add == ["NET_BIND_SERVICE"])
    and (($sfu.security_opt | index("no-new-privileges:true")) != null)
    and (($turn.security_opt | index("no-new-privileges:true")) != null)
    and (($sfu.ports | length) > 0)
    and (($turn.ports | length) > 0)
    and all($sfu.ports[]; .host_ip == "127.0.0.1")
    and all($turn.ports[]; .host_ip == "127.0.0.1")
    and ($sfu.healthcheck.test[0] == "CMD")
    and ($turn.healthcheck.test[0] == "CMD")
    and ($sfu.depends_on.turn.condition == "service_healthy")
' "$calls_config" >/dev/null || {
  echo "Calls Compose security invariants failed." >&2
  exit 1
}

echo "Compose topology security invariants: OK"
