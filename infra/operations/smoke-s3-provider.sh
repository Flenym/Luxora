#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SERVER_IMAGE='minio/minio:RELEASE.2025-09-07T16-13-09Z-cpuv1@sha256:13582eff79c6605a2d315bdd0e70164142ea7e98fc8411e9e10d089502a6d883'
MC_IMAGE='minio/mc:RELEASE.2025-08-13T08-35-41Z-cpuv1@sha256:95b5f3f7969a5c5a9f3a700ba72d5c84172819e13385aaf916e237cf111ab868'
API_IMAGE="${LUXORA_S3_GATE_API_IMAGE:-luxora-api:beta-0.1}"

for command_name in docker jq openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done
docker info >/dev/null 2>&1 || {
  echo "Docker daemon is unavailable." >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
runner_path="$repo_root/infra/operations/s3-provider-live.mjs"
[[ -f "$runner_path" && -f "$repo_root/services/api/Dockerfile" ]] || {
  echo "Run this gate from an intact Luxora repository checkout." >&2
  exit 1
}

run_id="$(openssl rand -hex 8)"
bucket="luxora-s3-gate-$run_id"
network="luxora-s3-gate-net-$run_id"
volume="luxora-s3-gate-data-$run_id"
server_container="luxora-s3-gate-server-$run_id"
policy_name="luxora-s3-gate-policy-$run_id"
service_access="luxorasvc$run_id"
service_secret="$(openssl rand -hex 24)"
root_access="luxoraroot$run_id"
root_secret="$(openssl rand -hex 24)"
static_sse_key="gate-$run_id:$(openssl rand -base64 32 | tr -d '\n')"
temp_parent="${TMPDIR:-/tmp}"
temp_dir="$(mktemp -d "$temp_parent/luxora-s3-gate.XXXXXXXX")"
policy_path="$temp_dir/service-policy.json"
runner_result_path="$temp_dir/provider-result.json"
versions_path="$temp_dir/versions.jsonl"
lifecycle_path="$temp_dir/lifecycle.json"

[[ "$run_id" =~ ^[a-f0-9]{16}$ ]] || { echo "Unsafe synthetic run ID." >&2; exit 1; }
[[ "$bucket" == "luxora-s3-gate-$run_id" ]] || { echo "Unsafe bucket name." >&2; exit 1; }
[[ "$network" == "luxora-s3-gate-net-$run_id" ]] || { echo "Unsafe network name." >&2; exit 1; }
[[ "$volume" == "luxora-s3-gate-data-$run_id" ]] || { echo "Unsafe volume name." >&2; exit 1; }
[[ "$server_container" == "luxora-s3-gate-server-$run_id" ]] || { echo "Unsafe container name." >&2; exit 1; }
[[ "$policy_name" == "luxora-s3-gate-policy-$run_id" ]] || { echo "Unsafe policy name." >&2; exit 1; }
[[ "$service_access" != "$root_access" ]] || { echo "Service and bootstrap identities must differ." >&2; exit 1; }
[[ "$temp_dir" == "$temp_parent"/luxora-s3-gate.* ]] || { echo "Unsafe temporary path." >&2; exit 1; }

network_created=0
volume_created=0
server_started=0
bucket_created=0
user_created=0
policy_created=0
store_cleaned=0
docker_cleaned=0

root_mc() {
  docker run --rm \
    --network "$network" \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --volume "$policy_path:/gate-input/service-policy.json:ro" \
    --env "MC_HOST_gate=http://$root_access:$root_secret@$server_container:9000" \
    "$MC_IMAGE" --config-dir /tmp/.mc --disable-pager --no-color "$@"
}

network_http_status() {
  docker run --rm \
    --network "$network" \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --entrypoint /nodejs/bin/node \
    "$API_IMAGE" --input-type=module --eval '
      const response = await fetch(process.argv[1], { redirect: "error" });
      if (response.body !== null) await response.body.cancel();
      process.stdout.write(String(response.status));
    ' "$1"
}

best_effort_store_cleanup() {
  (( server_started == 1 )) || return 0
  if (( bucket_created == 1 )); then
    root_mc rm --recursive --force --versions "gate/$bucket" >/dev/null 2>&1 || true
    root_mc rb --force "gate/$bucket" >/dev/null 2>&1 || true
  fi
  if (( policy_created == 1 && user_created == 1 )); then
    root_mc admin policy detach gate "$policy_name" --user "$service_access" >/dev/null 2>&1 || true
  fi
  if (( user_created == 1 )); then
    root_mc admin user rm gate "$service_access" >/dev/null 2>&1 || true
  fi
  if (( policy_created == 1 )); then
    root_mc admin policy rm gate "$policy_name" >/dev/null 2>&1 || true
  fi
}

best_effort_docker_cleanup() {
  if (( server_started == 1 )); then
    docker rm --force "$server_container" >/dev/null 2>&1 || true
  fi
  if (( volume_created == 1 )); then
    docker volume rm "$volume" >/dev/null 2>&1 || true
  fi
  if (( network_created == 1 )); then
    docker network rm "$network" >/dev/null 2>&1 || true
  fi
}

cleanup_temp_dir() {
  [[ "$temp_dir" == "$temp_parent"/luxora-s3-gate.* ]] || return 1
  find "$temp_dir" -mindepth 1 -maxdepth 1 -type f -delete
  rmdir "$temp_dir"
}

on_exit() {
  local status="$1"
  trap - EXIT INT TERM
  set +e
  if (( store_cleaned == 0 )); then best_effort_store_cleanup; fi
  if (( docker_cleaned == 0 )); then best_effort_docker_cleanup; fi
  if (( status != 0 )) && [[ -s "$runner_result_path" ]]; then
    echo "Provider runner stdout before failure:" >&2
    jq . "$runner_result_path" >&2 2>/dev/null || sed -n '1,80p' "$runner_result_path" >&2
  fi
  if (( status != 0 )) && [[ -s "$versions_path" ]]; then
    echo "Synthetic version records before failure:" >&2
    sed -n '1,80p' "$versions_path" >&2
  fi
  cleanup_temp_dir >/dev/null 2>&1 || true
  if (( status != 0 )); then
    echo "S3 live gate failed; exact synthetic Docker resources were cleanup targets (run $run_id)." >&2
  fi
  exit "$status"
}
trap 'on_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

jq -n --arg bucket "$bucket" '{
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetBucketLocation", "s3:ListBucket"],
      Resource: ["arn:aws:s3:::" + $bucket]
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: ["arn:aws:s3:::" + $bucket + "/attachments/*"]
    }
  ]
}' >"$policy_path"

echo "[s3-live] Pulling digest-pinned MinIO images..."
docker pull "$SERVER_IMAGE" >/dev/null
docker pull "$MC_IMAGE" >/dev/null
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || {
  echo "API image $API_IMAGE is missing; run 'make docker-build' or use 'make s3-live-gate'." >&2
  exit 1
}

docker network create --internal "$network" >/dev/null
network_created=1
docker volume create "$volume" >/dev/null
volume_created=1

docker run --detach \
  --name "$server_container" \
  --network "$network" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --tmpfs /root/.minio:rw,noexec,nosuid,nodev,size=16m \
  --volume "$volume:/data" \
  --env "MINIO_ROOT_USER=$root_access" \
  --env "MINIO_ROOT_PASSWORD=$root_secret" \
  --env "MINIO_KMS_SECRET_KEY=$static_sse_key" \
  --env MINIO_KMS_AUTO_ENCRYPTION=off \
  "$SERVER_IMAGE" server /data --address :9000 --console-address :9001 >/dev/null
server_started=1

docker network inspect "$network" | jq -e '.[0].Internal == true' >/dev/null
docker inspect "$server_container" | jq -e '
  .[0].HostConfig.ReadonlyRootfs == true and
  .[0].HostConfig.Privileged == false and
  (.[0].HostConfig.CapDrop | index("ALL") != null) and
  (.[0].HostConfig.SecurityOpt | any(startswith("no-new-privileges"))) and
  ((.[0].HostConfig.PortBindings // {}) | length == 0) and
  (all(.[0].Mounts[]; .Type != "bind"))
' >/dev/null

ready=0
for _ in $(seq 1 60); do
  if [[ "$(network_http_status "http://$server_container:9000/minio/health/ready" 2>/dev/null || true)" == "200" ]]; then
    ready=1
    break
  fi
  sleep 1
done
if (( ready != 1 )); then
  docker logs --tail 100 "$server_container" >&2 || true
  echo "MinIO did not become ready on its isolated Docker network." >&2
  exit 1
fi

echo "[s3-live] Bootstrapping private versioned SSE-S3 bucket and scoped identity..."
root_mc mb "gate/$bucket" >/dev/null
bucket_created=1
root_mc anonymous set none "gate/$bucket" >/dev/null
root_mc version enable "gate/$bucket" >/dev/null
root_mc encrypt set sse-s3 "gate/$bucket" >/dev/null
root_mc ilm rule add \
  --prefix attachments/ \
  --expire-days 7 \
  --noncurrent-expire-days 1 \
  "gate/$bucket" >/dev/null
root_mc ilm rule add \
  --prefix attachments/ \
  --expire-delete-marker \
  "gate/$bucket" >/dev/null
root_mc ilm rule export "gate/$bucket" >"$lifecycle_path"

root_mc admin user add gate "$service_access" "$service_secret" >/dev/null
user_created=1
root_mc admin policy create gate "$policy_name" /gate-input/service-policy.json >/dev/null
policy_created=1
root_mc admin policy attach gate "$policy_name" --user "$service_access" >/dev/null

root_mc version info "gate/$bucket" | grep -Eq 'Enabled|enabled'
root_mc encrypt info "gate/$bucket" | grep -Eq 'SSE-S3|sse-s3'
jq -e '
  .Rules as $rules |
  ($rules | length == 2) and
  all($rules[]; .Status == "Enabled" and .Filter.Prefix == "attachments/") and
  any($rules[];
    .Expiration.Days == 7 and
    .NoncurrentVersionExpiration.NoncurrentDays == 1
  ) and
  any($rules[]; .Expiration.ExpiredObjectDeleteMarker == true)
' "$lifecycle_path" >/dev/null

echo "[s3-live] Exercising the production S3StorageProvider and fault proxy..."
docker run --rm \
  --network "$network" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /app/data:rw,noexec,nosuid,nodev,size=16m \
  --volume "$runner_path:/luxora-gate/s3-provider-live.mjs:ro" \
  --env "AWS_ACCESS_KEY_ID=$service_access" \
  --env "AWS_SECRET_ACCESS_KEY=$service_secret" \
  --env AWS_REGION=us-east-1 \
  --env AWS_EC2_METADATA_DISABLED=true \
  --env "LUXORA_GATE_BUCKET=$bucket" \
  --env "LUXORA_GATE_ENDPOINT=http://$server_container:9000" \
  --env "LUXORA_GATE_RUN_ID=$run_id" \
  --entrypoint /nodejs/bin/node \
  "$API_IMAGE" /luxora-gate/s3-provider-live.mjs >"$runner_result_path"

if ! jq -e '
    .status == "pass" and
    .provider == "S3StorageProvider" and
    .readiness == true and
    .sseS3WriteReadConfirmed == true and
    .deleteCurrentObjectConfirmed == true and
    .droppedPutResponses >= 1 and
    .cleanupDeletes >= 1 and
    (.deniedPutError == "AccessDenied" or .deniedPutError == "Forbidden") and
    (.deniedDeleteError == "AccessDenied" or .deniedDeleteError == "Forbidden")
  ' "$runner_result_path" >/dev/null; then
  echo "Production provider runner returned an unexpected result:" >&2
  jq . "$runner_result_path" >&2 || true
  exit 1
fi

public_probe_key="$(jq -r '.publicProbeKey' "$runner_result_path")"
crud_key="$(jq -r '.crudKey' "$runner_result_path")"
ambiguous_key="$(jq -r '.ambiguousKey' "$runner_result_path")"
denied_key="$(jq -r '.deniedKey' "$runner_result_path")"
[[ "$public_probe_key" == "attachments/live-gate/$run_id/public-denial.bin" ]] || exit 1
[[ "$crud_key" == "attachments/live-gate/$run_id/crud.bin" ]] || exit 1
[[ "$ambiguous_key" == "attachments/live-gate/$run_id/ambiguous-put.bin" ]] || exit 1
[[ "$denied_key" == "outside-live-gate/$run_id/denied.bin" ]] || exit 1

public_status="$(network_http_status "http://$server_container:9000/$bucket/$public_probe_key")"
[[ "$public_status" == "403" ]] || {
  echo "Unauthenticated object request returned HTTP $public_status, expected 403." >&2
  exit 1
}

root_mc ls --versions --recursive --json "gate/$bucket" >"$versions_path"
jq -s -e --arg key "$crud_key" '
  map(select(.key == $key)) as $versions |
  any($versions[]; .isDeleteMarker == true) and
  any($versions[]; (.isDeleteMarker // false) == false)
' "$versions_path" >/dev/null
jq -s -e --arg key "$ambiguous_key" '
  map(select(.key == $key)) as $versions |
  any($versions[]; .isDeleteMarker == true) and
  any($versions[]; (.isDeleteMarker // false) == false)
' "$versions_path" >/dev/null
jq -s -e --arg key "$denied_key" 'all(.[]; .key != $key)' "$versions_path" >/dev/null

echo "[s3-live] Verifying exact cleanup of the synthetic bucket, identity and Docker resources..."
root_mc rm --recursive --force --versions "gate/$bucket" >/dev/null
root_mc rb "gate/$bucket" >/dev/null
root_mc admin policy detach gate "$policy_name" --user "$service_access" >/dev/null
root_mc admin user rm gate "$service_access" >/dev/null
root_mc admin policy rm gate "$policy_name" >/dev/null

if root_mc stat "gate/$bucket" >/dev/null 2>&1; then
  echo "Synthetic bucket remained after cleanup." >&2
  exit 1
fi
if root_mc admin user info gate "$service_access" >/dev/null 2>&1; then
  echo "Synthetic service identity remained after cleanup." >&2
  exit 1
fi
if root_mc admin policy info gate "$policy_name" >/dev/null 2>&1; then
  echo "Synthetic policy remained after cleanup." >&2
  exit 1
fi
store_cleaned=1

docker rm --force "$server_container" >/dev/null
server_started=0
docker volume rm "$volume" >/dev/null
volume_created=0
docker network rm "$network" >/dev/null
network_created=0
docker_cleaned=1

! docker container inspect "$server_container" >/dev/null 2>&1
! docker volume inspect "$volume" >/dev/null 2>&1
! docker network inspect "$network" >/dev/null 2>&1

server_arch="$(docker image inspect "$SERVER_IMAGE" --format '{{.Architecture}}')"
mc_arch="$(docker image inspect "$MC_IMAGE" --format '{{.Architecture}}')"
ambiguous_drops="$(jq -r '.droppedPutResponses' "$runner_result_path")"
cleanup_deletes="$(jq -r '.cleanupDeletes' "$runner_result_path")"
version_records="$(jq -s 'length' "$versions_path")"

echo "S3 live provider gate: PASS"
echo "  MinIO server: $SERVER_IMAGE ($server_arch)"
echo "  MinIO client: $MC_IMAGE ($mc_arch)"
echo "  Isolation: internal network, no host ports, read-only/cap-drop/no-new-privileges"
echo "  Provider: readiness + SSE-S3 PUT/full GET/Range GET/DELETE"
echo "  IAM/public: service identity != bootstrap admin; cross-prefix denied; anonymous GET HTTP 403"
echo "  Versioning: $version_records synthetic version/delete-marker records observed; lifecycle configured"
echo "  Ambiguity: $ambiguous_drops committed PUT response(s) dropped; $cleanup_deletes provider cleanup DELETE(s) observed"
echo "  Cleanup: bucket versions, bucket, service identity, policy, container, volume and network absent"

cleanup_temp_dir
trap - EXIT INT TERM
