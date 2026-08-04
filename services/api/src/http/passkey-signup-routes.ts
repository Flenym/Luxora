import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BeginPasskeySignupRequestSchema,
  PASSKEY_BOOTSTRAP_AUTHORIZATION_HEADER,
  PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH,
  PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH,
  PasskeyBootstrapAuthorizationHeaderSchema,
  PasskeyCeremonyRevisionETagSchema,
  PasskeyCredentialContentTypeSchema,
  PasskeyIdempotencyKeySchema,
  PasskeySignupBeginResponseSchema,
  PasskeySignupVerifyResponseSchema,
  VerifyPasskeySignupRequestSchema,
  type PasskeySignupBeginResponse,
  type PasskeySignupVerifyResponse
} from "@luxora/protocol";

import { anonymousPasskeyIpBucketKey } from "../client-ip.js";
import { AppError, badRequest } from "../errors.js";
import type {
  BeginPasskeySignupServiceInput,
  VerifyPasskeySignupServiceInput
} from "../services/passkey-signup-service.js";
import {
  ensurePasskeyResponseContentParser,
  parsePasskeyResponseBody,
  PASSKEY_RESPONSE_CONTENT_TYPE,
  type ParsedPasskeyResponseBody
} from "./passkey-response-body.js";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const IF_MATCH_HEADER = "If-Match";
const CONTENT_TYPE_HEADER = "Content-Type";
const registeredInstances = new WeakSet<FastifyInstance>();

interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export interface PasskeySignupRouteService {
  begin(input: BeginPasskeySignupServiceInput): Promise<PasskeySignupBeginResponse>;
  verify(input: VerifyPasskeySignupServiceInput): Promise<PasskeySignupVerifyResponse>;
}

export interface PasskeySignupRouteDependencies {
  readonly service: PasskeySignupRouteService;
}

function readSingleHeader(request: FastifyRequest, name: string): string {
  const normalizedName = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const rawName = request.raw.rawHeaders[index];
    if (typeof rawName !== "string" || rawName.toLowerCase() !== normalizedName) continue;
    const rawValue = request.raw.rawHeaders[index + 1];
    if (typeof rawValue !== "string") throw badRequest(`Invalid ${name} header`);
    values.push(rawValue);
  }
  const normalized = request.headers[normalizedName];
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || typeof normalized !== "string"
    || value.includes(",")
    || normalized.includes(",")
  ) throw badRequest(`Invalid ${name} header`);
  return value;
}

function parseHeader<T>(request: FastifyRequest, name: string, schema: SafeParser<T>): T {
  const parsed = schema.safeParse(readSingleHeader(request, name));
  if (!parsed.success) throw badRequest(`Invalid ${name} header`);
  return parsed.data;
}

function parseUntrusted<T>(schema: SafeParser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid passkey signup request");
  return parsed.data;
}

function parseTrusted<T>(schema: SafeParser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, "INTERNAL_ERROR", "Passkey signup response validation failed");
  }
  return parsed.data;
}

function requireQueryFreeRequest(request: FastifyRequest): void {
  const rawUrl = request.raw.url;
  if (typeof rawUrl !== "string" || rawUrl.includes("?") || rawUrl.includes("#")) {
    throw badRequest("Passkey signup URLs must not contain a query string");
  }
}

function requirePasskeyContentType(request: FastifyRequest): void {
  let value: string;
  try {
    value = readSingleHeader(request, CONTENT_TYPE_HEADER);
  } catch {
    throw new AppError(415, "BAD_REQUEST", "Unsupported media type");
  }
  if (!PasskeyCredentialContentTypeSchema.safeParse(value).success) {
    throw new AppError(415, "BAD_REQUEST", "Unsupported media type");
  }
}

async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function sendCeremonyResponse(
  reply: FastifyReply,
  response: PasskeySignupBeginResponse | PasskeySignupVerifyResponse
) {
  return reply
    .header("etag", `"${response.ceremony.revision}"`)
    .code(200)
    .send(response);
}

async function withConflictRevisionETag<T>(
  reply: FastifyReply,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) {
      const details = error.details;
      const revision = details?.["revision"];
      if (
        details?.["reason"] === "ceremony_conflict"
        && typeof revision === "number"
        && Number.isSafeInteger(revision)
        && revision >= 1
      ) {
        reply.header("etag", `"${revision}"`);
      }
    }
    throw error;
  }
}

/**
 * Registers only the still-internal pre-account signup transport. Merely
 * importing this module never changes application composition or capabilities;
 * the app registers it only behind the separate non-production signup flag.
 */
export function registerPasskeySignupRoutes(
  app: FastifyInstance,
  dependencies: PasskeySignupRouteDependencies
): void {
  if (registeredInstances.has(app)) {
    throw new Error("Passkey signup routes are already registered on this Fastify instance");
  }
  ensurePasskeyResponseContentParser(app);

  app.post(PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH, {
    onRequest: noStore,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute",
        keyGenerator: (request) => anonymousPasskeyIpBucketKey(request.ip)
      }
    }
  }, async (request, reply) => {
    requireQueryFreeRequest(request);
    const body = parseUntrusted(BeginPasskeySignupRequestSchema, request.body);
    const commandId = parseHeader(
      request,
      IDEMPOTENCY_KEY_HEADER,
      PasskeyIdempotencyKeySchema
    );
    const serviceResponse = await withConflictRevisionETag(reply, async () => (
      dependencies.service.begin({
        commandId,
        clientNonce: body.clientNonce,
        deliveryNonce: body.deliveryNonce,
        username: body.username,
        displayName: body.displayName,
        deviceName: body.deviceName
      })
    ));
    const response = parseTrusted(PasskeySignupBeginResponseSchema, serviceResponse);
    return sendCeremonyResponse(reply, response);
  });

  app.post(PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH, {
    onRequest: noStore,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (request) => anonymousPasskeyIpBucketKey(request.ip)
      }
    }
  }, async (request, reply) => {
    requireQueryFreeRequest(request);
    const commandId = parseHeader(
      request,
      IDEMPOTENCY_KEY_HEADER,
      PasskeyIdempotencyKeySchema
    );
    const expectedRevision = parseHeader(
      request,
      IF_MATCH_HEADER,
      PasskeyCeremonyRevisionETagSchema
    );
    const signupAuthorization = parseHeader(
      request,
      PASSKEY_BOOTSTRAP_AUTHORIZATION_HEADER,
      PasskeyBootstrapAuthorizationHeaderSchema
    );
    requirePasskeyContentType(request);

    const transport = parsePasskeyResponseBody(request.body);
    const credential = parseUntrusted(
      VerifyPasskeySignupRequestSchema,
      transport.credential
    );
    const responseBody: ParsedPasskeyResponseBody = Object.freeze({
      credential,
      byteLength: transport.byteLength,
      digest: transport.digest
    });
    const serviceResponse = await withConflictRevisionETag(reply, async () => (
      dependencies.service.verify({
        commandId,
        expectedRevision,
        signupAuthorization,
        response: responseBody
      })
    ));
    const response = parseTrusted(PasskeySignupVerifyResponseSchema, serviceResponse);
    return sendCeremonyResponse(reply, response);
  });

  registeredInstances.add(app);
}

export { PASSKEY_RESPONSE_CONTENT_TYPE };
