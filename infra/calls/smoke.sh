#!/usr/bin/env bash
set -euo pipefail

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
project_name="luxora-calls-smoke-$$"
compose=(
  docker compose
  --project-name "$project_name"
  --env-file infra/calls/environment.example
  --file docker-compose.calls.yml
)

# Keep smoke credentials process-local. They are independent and never written
# to the repository or printed by this script.
export LIVEKIT_API_KEY="luxora_smoke_key"
export LIVEKIT_API_SECRET
export TURN_SHARED_SECRET
LIVEKIT_API_SECRET=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
TURN_SHARED_SECRET=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')

started=0
cleanup() {
  status=$?
  if [[ "$started" -eq 1 ]]; then
    "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$repo_root"
"${compose[@]}" config --quiet
started=1
"${compose[@]}" up --detach --wait --wait-timeout 45

curl --fail --silent --show-error http://127.0.0.1:7880/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1:6789/metrics >/dev/null
curl --fail --silent --show-error http://127.0.0.1:9641/metrics >/dev/null

# coturn's test client derives an ephemeral REST username/password from -W.
# Zero data packets keeps this an authentication/allocation probe rather than a
# media-quality claim.
"${compose[@]}" exec -T turn turnutils_uclient \
  -n 0 -c -W "$TURN_SHARED_SECRET" -p "${TURN_PORT:-3478}" \
  -e "${CALLS_NODE_IP:-172.31.80.10}" -r 7882 127.0.0.1 \
  >/dev/null 2>&1

if "${compose[@]}" exec -T turn turnutils_uclient \
  -n 0 -c -W "intentionally-wrong-turn-secret" -p "${TURN_PORT:-3478}" \
  -e "${CALLS_NODE_IP:-172.31.80.10}" -r 7882 127.0.0.1 \
  >/dev/null 2>&1; then
  echo "TURN accepted a credential derived from the wrong secret" >&2
  exit 1
fi

echo "Calls harness smoke: health, metrics, TURN auth accept/reject OK"
