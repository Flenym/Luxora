#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

for required_command in curl docker jq openssl uuidgen; do
  command -v "$required_command" >/dev/null || {
    printf '%s is required\n' "$required_command" >&2
    exit 1
  }
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${LUXORA_API_IMAGE:-luxora-api:beta-0.1}"
random_suffix="$(openssl rand -hex 4)"
container_name="luxora-api-log-canary-$$-${random_suffix}"
volume_name="${container_name}-data"
container_created=0
volume_created=0

resources_are_synthetic() {
  [[ "$container_name" =~ ^luxora-api-log-canary-[0-9]+-[0-9a-f]{8}$ ]] &&
    [[ "$volume_name" == "${container_name}-data" ]]
}

cleanup_resources() {
  resources_are_synthetic || {
    printf 'Refusing unsafe cleanup names: %s / %s\n' "$container_name" "$volume_name" >&2
    return 1
  }

  local cleanup_status=0
  if [[ "$container_created" -eq 1 ]]; then
    if docker rm --force "$container_name" >/dev/null 2>&1; then
      container_created=0
    else
      cleanup_status=1
    fi
  fi
  if [[ "$volume_created" -eq 1 ]]; then
    if docker volume rm "$volume_name" >/dev/null 2>&1; then
      volume_created=0
    else
      cleanup_status=1
    fi
  fi
  return "$cleanup_status"
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if ! cleanup_resources && [[ "$status" -eq 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo_root"
docker image inspect "$image" >/dev/null
docker volume create "$volume_name" >/dev/null
volume_created=1

jwt_secret="$(openssl rand -hex 48)"
data_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
data_keys_json="{\"canary\":\"${data_key}\"}"

docker run --detach \
  --name "$container_name" \
  --init \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --publish 127.0.0.1::8080 \
  --volume "${volume_name}:/app/data" \
  --env NODE_ENV=production \
  --env HOST=0.0.0.0 \
  --env PORT=8080 \
  --env DATABASE_PATH=/app/data/luxora.db \
  --env STORAGE_LOCAL_PATH=/app/data/blobs \
  --env UPLOAD_STAGING_PATH=/app/data/uploads \
  --env JWT_SECRET="$jwt_secret" \
  --env CORS_ORIGINS=https://luxora.invalid \
  --env TRUSTED_PROXY_CIDRS= \
  --env DATA_ENCRYPTION_KEYS="$data_keys_json" \
  --env ACTIVE_DATA_ENCRYPTION_KEY_ID=canary \
  "$image" >/dev/null
container_created=1

host_binding="$(docker port "$container_name" 8080/tcp | head -n 1)"
host_port="${host_binding##*:}"
[[ "$host_binding" == "127.0.0.1:${host_port}" && "$host_port" =~ ^[0-9]+$ ]] || {
  printf 'Unexpected API port binding: %s\n' "$host_binding" >&2
  exit 1
}
base_url="http://127.0.0.1:${host_port}"

ready=0
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "${base_url}/health/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || {
  docker logs "$container_name" >&2
  exit 1
}

sender_username="lc${random_suffix}"
recipient_username="lp${random_suffix}"
sender_password="Luxora-canary-password-A-${random_suffix}"
recipient_password="Luxora-canary-password-B-${random_suffix}"
private_content="LUXORA_PRIVATE_CONTENT_CANARY_${random_suffix}"
invalid_bearer="LUXORA_INVALID_BEARER_CANARY_${random_suffix}"
client_request_id="LUXORA_CLIENT_REQUEST_ID_CANARY_${random_suffix}"
attachment_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
unmatched_path="LUXORA_UNMATCHED_PATH_CANARY_${random_suffix}"

sender_payload="$(jq -nc \
  --arg username "$sender_username" \
  --arg password "$sender_password" \
  '{username:$username,displayName:"Log canary sender",password:$password,deviceName:"Canary sender"}')"
sender_response="$(curl --silent --show-error \
  --request POST "${base_url}/v1/auth/register" \
  --header 'content-type: application/json' \
  --data "$sender_payload" \
  --write-out '\n%{http_code}')"
sender_status="${sender_response##*$'\n'}"
sender_body="${sender_response%$'\n'*}"
[[ "$sender_status" == "201" ]] || {
  printf 'Sender registration returned %s\n' "$sender_status" >&2
  exit 1
}
sender_access_token="$(printf '%s' "$sender_body" | jq -er '.tokens.accessToken')"
sender_refresh_token="$(printf '%s' "$sender_body" | jq -er '.tokens.refreshToken')"

recipient_payload="$(jq -nc \
  --arg username "$recipient_username" \
  --arg password "$recipient_password" \
  '{username:$username,displayName:"Log canary recipient",password:$password,deviceName:"Canary recipient"}')"
recipient_response="$(curl --silent --show-error \
  --request POST "${base_url}/v1/auth/register" \
  --header 'content-type: application/json' \
  --data "$recipient_payload" \
  --write-out '\n%{http_code}')"
recipient_status="${recipient_response##*$'\n'}"
recipient_body="${recipient_response%$'\n'*}"
[[ "$recipient_status" == "201" ]] || {
  printf 'Recipient registration returned %s\n' "$recipient_status" >&2
  exit 1
}
recipient_id="$(printf '%s' "$recipient_body" | jq -er '.user.id')"

lookup_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  --get "${base_url}/v1/users/lookup" \
  --data-urlencode "username=${recipient_username}" \
  --header "authorization: Bearer ${sender_access_token}")"
[[ "$lookup_status" == "200" ]] || {
  printf 'Exact lookup returned %s\n' "$lookup_status" >&2
  exit 1
}

request_nonce="$(uuidgen | tr '[:upper:]' '[:lower:]')"
request_payload="$(jq -nc \
  --arg recipient "$recipient_id" \
  --arg body "$private_content" \
  --arg nonce "$request_nonce" \
  '{recipientUserId:$recipient,body:$body,clientNonce:$nonce}')"
request_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  --request POST "${base_url}/v1/message-requests" \
  --header 'content-type: application/json' \
  --header "authorization: Bearer ${sender_access_token}" \
  --data "$request_payload")"
[[ "$request_status" == "201" ]] || {
  printf 'Durable message request returned %s\n' "$request_status" >&2
  exit 1
}

invalid_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  "${base_url}/v1/me" \
  --header "authorization: Bearer ${invalid_bearer}")"
[[ "$invalid_status" == "401" ]] || {
  printf 'Invalid bearer probe returned %s\n' "$invalid_status" >&2
  exit 1
}

missing_attachment_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  "${base_url}/v1/attachments/${attachment_id}/content" \
  --header "authorization: Bearer ${sender_access_token}" \
  --header "x-request-id: ${client_request_id}")"
[[ "$missing_attachment_status" == "404" ]] || {
  printf 'Missing attachment probe returned %s\n' "$missing_attachment_status" >&2
  exit 1
}

unmatched_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  "${base_url}/unmatched/${unmatched_path}" \
  --header "x-request-id: ${client_request_id}")"
[[ "$unmatched_status" == "404" ]] || {
  printf 'Unmatched path probe returned %s\n' "$unmatched_status" >&2
  exit 1
}

docker inspect "$container_name" | jq -e '
  .[0] as $container
  | ($container.Config.User == "65532:65532")
    and ($container.HostConfig.ReadonlyRootfs == true)
    and ($container.HostConfig.Privileged == false)
    and ($container.HostConfig.CapDrop == ["ALL"])
    and ($container.HostConfig.SecurityOpt | index("no-new-privileges:true") != null)
    and ($container.NetworkSettings.Ports["8080/tcp"][0].HostIp == "127.0.0.1")
' >/dev/null

logs="$(docker logs "$container_name" 2>&1)"
for forbidden in \
  "$sender_username" \
  "$recipient_username" \
  "$sender_password" \
  "$recipient_password" \
  "$private_content" \
  "$invalid_bearer" \
  "$client_request_id" \
  "$attachment_id" \
  "$unmatched_path" \
  "$sender_access_token" \
  "$sender_refresh_token" \
  '?username=' \
  authorization; do
  if [[ "$logs" == *"$forbidden"* ]]; then
    printf 'API log contains forbidden canary class\n' >&2
    exit 1
  fi
done

lookup_log_count="$(printf '%s\n' "$logs" | jq -s '
  [.[] | select(
    .msg == "incoming request"
    and .req.method == "GET"
    and .req.path == "/v1/users/lookup"
  )] | length
')"
[[ "$lookup_log_count" -ge 1 ]] || {
  printf 'Query-free lookup path was not retained in structured logs\n' >&2
  exit 1
}
attachment_log_count="$(printf '%s\n' "$logs" | jq -s '
  [.[] | select(
    .msg == "incoming request"
    and .req.method == "GET"
    and .req.path == "/v1/attachments/:id/content"
  )] | length
')"
[[ "$attachment_log_count" -ge 1 ]] || {
  printf 'Attachment route template was not retained in structured logs\n' >&2
  exit 1
}

docker stop --time 15 "$container_name" >/dev/null

docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "${volume_name}:/data" \
  --env CANARY_PASSWORD_A="$sender_password" \
  --env CANARY_PASSWORD_B="$recipient_password" \
  --env CANARY_PRIVATE_CONTENT="$private_content" \
  --entrypoint /nodejs/bin/node \
  "$image" \
  -e '
    const fs = require("node:fs");
    const Database = require("better-sqlite3");
    const database = new Database("/data/luxora.db", { readonly: true, fileMustExist: true });
    const integrity = database.pragma("integrity_check")[0]?.integrity_check;
    const foreignKeyViolations = database.pragma("foreign_key_check").length;
    const migrations = database.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((row) => row.id);
    const requests = database.prepare("SELECT body_ciphertext FROM message_requests").all();
    const encrypted = requests.length === 1 && requests.every((row) =>
      typeof row.body_ciphertext === "string" && row.body_ciphertext.startsWith("luxora:v1.")
    );
    const forbidden = [
      process.env.CANARY_PASSWORD_A,
      process.env.CANARY_PASSWORD_B,
      process.env.CANARY_PRIVATE_CONTENT
    ];
    const databaseFiles = fs.readdirSync("/data").filter((name) => name.startsWith("luxora.db"));
    const rawLeak = databaseFiles.some((name) => {
      const bytes = fs.readFileSync(`/data/${name}`);
      return forbidden.some((value) => typeof value === "string" && bytes.includes(Buffer.from(value)));
    });
    if (
      integrity !== "ok"
      || foreignKeyViolations !== 0
      || !migrations.includes("005_identity_access_safety")
      || !encrypted
      || rawLeak
    ) process.exit(1);
    console.log(JSON.stringify({
      integrity,
      foreignKeyViolations,
      migrationCount: migrations.length,
      encryptedRequestRows: requests.length,
      rawCanariesAbsent: !rawLeak
    }));
    database.close();
  '

cleanup_resources
trap - EXIT INT TERM
printf 'Luxora Beta-0.1 API log/content/token canary PASS; synthetic container and volume removed.\n'
