import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

import { S3StorageProvider } from "/app/services/api/dist/infrastructure/storage.js";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function storageInput(objectKey, bytes) {
  return {
    objectKey,
    sourceFactory: () => Readable.from([bytes]),
    sizeBytes: bytes.length,
    mimeType: "application/octet-stream",
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function collect(readResult) {
  const chunks = [];
  for await (const chunk of readResult.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function awsErrorName(error) {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "unknown";
}

function awsStatus(error) {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) return undefined;
  return metadata.httpStatusCode;
}

async function expectDenied(operation, label) {
  try {
    await operation();
  } catch (error) {
    const name = awsErrorName(error);
    assert.ok(
      name === "AccessDenied" || name === "Forbidden" || awsStatus(error) === 403,
      `${label} failed with ${name}, not an authorization denial`
    );
    return name;
  }
  assert.fail(`${label} unexpectedly succeeded`);
}

async function expectMissing(operation, label) {
  try {
    const result = await operation();
    if (result?.stream !== undefined) await collect(result);
  } catch (error) {
    const name = awsErrorName(error);
    assert.ok(
      name === "NoSuchKey" || name === "NotFound" || awsStatus(error) === 404,
      `${label} failed with ${name}, not a missing-object response`
    );
    return name;
  }
  assert.fail(`${label} unexpectedly found an object`);
}

function createAmbiguousPutProxy(targetEndpoint, ambiguousObjectKey) {
  const target = new URL(targetEndpoint);
  let droppedPutResponses = 0;
  let cleanupDeletes = 0;

  const server = http.createServer((request, response) => {
    const requestPath = request.url ?? "/";
    const decodedPath = decodeURIComponent(requestPath.split("?", 1)[0] ?? requestPath);
    const targetsAmbiguousObject = decodedPath.endsWith(`/${ambiguousObjectKey}`);
    if (targetsAmbiguousObject && request.method === "DELETE") cleanupDeletes += 1;

    const upstreamRequest = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: requestPath,
      headers: request.headers
    });

    upstreamRequest.on("response", (upstreamResponse) => {
      if (targetsAmbiguousObject && request.method === "PUT") {
        upstreamResponse.resume();
        upstreamResponse.on("end", () => {
          droppedPutResponses += 1;
          if (response.socket !== null) response.socket.destroy();
          else response.destroy();
        });
        return;
      }

      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.on("error", (error) => response.destroy(error));
    request.on("error", (error) => upstreamRequest.destroy(error));
    request.pipe(upstreamRequest);
  });

  return {
    server,
    counters: () => ({ droppedPutResponses, cleanupDeletes })
  };
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null, "proxy did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

const bucket = requiredEnvironment("LUXORA_GATE_BUCKET");
const endpoint = requiredEnvironment("LUXORA_GATE_ENDPOINT");
const runId = requiredEnvironment("LUXORA_GATE_RUN_ID");
assert.match(bucket, /^luxora-s3-gate-[a-f0-9]{16}$/u, "bucket is not a synthetic gate bucket");
assert.match(runId, /^[a-f0-9]{16}$/u, "run ID is not synthetic");
assert.equal(
  endpoint,
  `http://luxora-s3-gate-server-${runId}:9000`,
  "endpoint is not the synthetic gate server"
);

const prefix = `attachments/live-gate/${runId}`;
const payload = Buffer.from(`Luxora Beta-0.1 live S3 provider gate ${runId}\n`, "utf8");
const config = {
  bucket,
  region: "us-east-1",
  endpoint,
  forcePathStyle: true,
  serverSideEncryption: "AES256"
};
const provider = new S3StorageProvider(config);
let ambiguousProvider;
let proxy;
let gateResult;

const crudKey = `${prefix}/crud.bin`;
const publicProbeKey = `${prefix}/public-denial.bin`;
const ambiguousKey = `${prefix}/ambiguous-put.bin`;
const deniedKey = `outside-live-gate/${runId}/denied.bin`;

try {
  assert.equal(await provider.ready(), true, "production S3 readiness probe failed");

  await provider.put(storageInput(crudKey, payload));
  const full = await collect(await provider.read(
    crudKey,
    payload.length,
    createHash("sha256").update(payload).digest("hex")
  ));
  assert.deepEqual(full, payload, "full provider read changed the payload");

  const range = { start: 7, end: 23 };
  const ranged = await collect(await provider.read(
    crudKey,
    payload.length,
    createHash("sha256").update(payload).digest("hex"),
    range
  ));
  assert.deepEqual(ranged, payload.subarray(range.start, range.end + 1), "Range read changed the selected bytes");

  await provider.delete(crudKey);
  const deletedReadError = await expectMissing(
    () => provider.read(crudKey, payload.length, createHash("sha256").update(payload).digest("hex")),
    "provider read after DeleteObject"
  );

  await provider.put(storageInput(publicProbeKey, payload));

  const deniedPutError = await expectDenied(
    () => provider.put(storageInput(deniedKey, payload)),
    "cross-prefix PutObject"
  );
  const deniedDeleteError = await expectDenied(
    () => provider.delete(deniedKey),
    "cross-prefix DeleteObject"
  );

  proxy = createAmbiguousPutProxy(endpoint, ambiguousKey);
  const proxyEndpoint = await listenLoopback(proxy.server);
  ambiguousProvider = new S3StorageProvider({ ...config, endpoint: proxyEndpoint });

  let ambiguousPutError = "none";
  try {
    await ambiguousProvider.put(storageInput(ambiguousKey, payload));
    assert.fail("ambiguous PutObject unexpectedly reported success");
  } catch (error) {
    ambiguousPutError = awsErrorName(error);
  }
  const ambiguity = proxy.counters();
  assert.ok(ambiguity.droppedPutResponses >= 1, "proxy did not drop a committed PUT response");
  assert.ok(ambiguity.cleanupDeletes >= 1, "provider did not attempt cleanup after ambiguous PUT failure");
  const ambiguousReadError = await expectMissing(
    () => provider.read(ambiguousKey, payload.length, createHash("sha256").update(payload).digest("hex")),
    "ambiguous PutObject cleanup"
  );

  gateResult = {
    status: "pass",
    provider: "S3StorageProvider",
    readiness: true,
    sseS3WriteReadConfirmed: true,
    fullReadBytes: full.length,
    rangeRead: range,
    deleteCurrentObjectConfirmed: true,
    deletedReadError,
    publicProbeKey,
    crudKey,
    ambiguousKey,
    deniedKey,
    deniedPutError,
    deniedDeleteError,
    ambiguousPutError,
    ambiguousReadError,
    ...ambiguity
  };
} finally {
  if (ambiguousProvider !== undefined) await ambiguousProvider.close();
  if (proxy !== undefined) await closeServer(proxy.server);
  await provider.close();
}

assert.ok(gateResult !== undefined, "provider gate produced no result");
process.stdout.write(`${JSON.stringify(gateResult)}\n`);
