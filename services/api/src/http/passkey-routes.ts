import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BeginPasskeyRegistrationRequestSchema,
  BeginPasskeyStepUpRequestSchema,
  PASSKEY_STEP_UP_AUTHORIZATION_HEADER,
  PasskeyCeremonyParamsSchema,
  PasskeyCeremonyRevisionETagSchema,
  PasskeyCeremonyVerifyRequestSchema,
  PasskeyCeremonyVerifyResponseSchema,
  PasskeyCredentialContentTypeSchema,
  PasskeyIdempotencyKeySchema,
  PasskeyRegistrationBeginResponseSchema,
  PasskeyStepUpAuthorizationHeaderSchema,
  PasskeyStepUpBeginResponseSchema,
  type PasskeyCeremonyVerifyResponse,
  type PasskeyRegistrationBeginResponse,
  type PasskeyStepUpBeginResponse
} from "@luxora/protocol";
import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError, badRequest } from "../errors.js";
import {
  ensurePasskeyResponseContentParser,
  parsePasskeyResponseBody,
  type ParsedPasskeyResponseBody,
  PASSKEY_RESPONSE_CONTENT_TYPE
} from "./passkey-response-body.js";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const IF_MATCH_HEADER = "If-Match";
const CONTENT_TYPE_HEADER = "Content-Type";
const registeredInstances = new WeakSet<FastifyInstance>();

interface SafeHeaderParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

interface SafeBoundaryParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export interface PasskeyRouteService {
  beginRegistration(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
      readonly stepUpCeremonyId: string;
      readonly stepUpToken: string;
    }
  ): Promise<PasskeyRegistrationBeginResponse>;
  beginStepUp(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
      readonly operation: "authenticator.add" | "device-link.approve";
      readonly linkId?: string;
    }
  ): Promise<PasskeyStepUpBeginResponse>;
  verify(
    principal: AuthenticatedPrincipal,
    input: {
      readonly ceremonyId: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly response: ParsedPasskeyResponseBody;
    }
  ): Promise<PasskeyCeremonyVerifyResponse>;
}

export interface PasskeyRouteDependencies {
  readonly service: PasskeyRouteService;
  readonly authGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function readSingleHeader(request: FastifyRequest, name: string): string {
  const normalizedName = name.toLowerCase();
  const values: string[] = [];
  const { rawHeaders } = request.raw;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    if (typeof rawName !== "string" || rawName.toLowerCase() !== normalizedName) continue;
    const rawValue = rawHeaders[index + 1];
    if (typeof rawValue !== "string") throw badRequest(`Invalid ${name} header`);
    values.push(rawValue);
  }

  const normalizedValue = request.headers[normalizedName];
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || typeof normalizedValue !== "string"
    || value.includes(",")
    || normalizedValue.includes(",")
  ) {
    throw badRequest(`Invalid ${name} header`);
  }
  return value;
}

function parseHeader<T>(
  request: FastifyRequest,
  name: string,
  schema: SafeHeaderParser<T>
): T {
  const parsed = schema.safeParse(readSingleHeader(request, name));
  if (!parsed.success) throw badRequest(`Invalid ${name} header`);
  return parsed.data;
}

function parseUntrusted<T>(schema: SafeBoundaryParser<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw badRequest("Invalid passkey request");
  return parsed.data;
}

function parseTrusted<T>(schema: SafeBoundaryParser<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // A malformed service result is a server contract breach, never a client
    // validation error. Keep schema internals and credential material private.
    throw new AppError(500, "INTERNAL_ERROR", "Passkey response validation failed");
  }
  return parsed.data;
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

function sendCeremonyResponse(
  reply: FastifyReply,
  response: PasskeyRegistrationBeginResponse | PasskeyStepUpBeginResponse | PasskeyCeremonyVerifyResponse
) {
  return reply
    .header("etag", `"${response.ceremony.revision}"`)
    .code(200)
    .send(response);
}

/**
 * Registers the passkey transport boundary exactly once on one Fastify
 * instance. The module is intentionally not wired by itself: the caller must
 * opt in once, before `ready()`, when the capability is safe to advertise.
 */
export function registerPasskeyRoutes(
  app: FastifyInstance,
  dependencies: PasskeyRouteDependencies
): void {
  if (registeredInstances.has(app)) {
    throw new Error("Passkey routes are already registered on this Fastify instance");
  }
  ensurePasskeyResponseContentParser(app);

  app.post("/v1/auth/passkey-ceremonies/registration", {
    onRequest: dependencies.authGuard
  }, async (request, reply) => {
    const body = parseUntrusted(BeginPasskeyRegistrationRequestSchema, request.body);
    const commandId = parseHeader(request, IDEMPOTENCY_KEY_HEADER, PasskeyIdempotencyKeySchema);
    // Header failures stay content-free: never put the bearer value in an
    // AppError, validation details, a response, or a log field.
    const stepUpToken = parseHeader(
      request,
      PASSKEY_STEP_UP_AUTHORIZATION_HEADER,
      PasskeyStepUpAuthorizationHeaderSchema
    );
    const response = parseTrusted(PasskeyRegistrationBeginResponseSchema,
      await dependencies.service.beginRegistration(request.auth, {
        commandId,
        clientNonce: body.clientNonce,
        stepUpCeremonyId: body.stepUpCeremonyId,
        stepUpToken
      })
    );
    return sendCeremonyResponse(reply, response);
  });

  app.post("/v1/auth/passkey-ceremonies/authentication", {
    onRequest: dependencies.authGuard
  }, async (request, reply) => {
    const body = parseUntrusted(BeginPasskeyStepUpRequestSchema, request.body);
    const commandId = parseHeader(request, IDEMPOTENCY_KEY_HEADER, PasskeyIdempotencyKeySchema);
    const response = parseTrusted(PasskeyStepUpBeginResponseSchema,
      await dependencies.service.beginStepUp(request.auth, {
        commandId,
        clientNonce: body.clientNonce,
        operation: body.operation,
        ...(body.linkId === undefined ? {} : { linkId: body.linkId })
      })
    );
    return sendCeremonyResponse(reply, response);
  });

  app.post("/v1/auth/passkey-ceremonies/:ceremonyId/verify", {
    onRequest: dependencies.authGuard
  }, async (request, reply) => {
    const { ceremonyId } = parseUntrusted(PasskeyCeremonyParamsSchema, request.params);
    const commandId = parseHeader(request, IDEMPOTENCY_KEY_HEADER, PasskeyIdempotencyKeySchema);
    const expectedRevision = parseHeader(
      request,
      IF_MATCH_HEADER,
      PasskeyCeremonyRevisionETagSchema
    );
    requirePasskeyContentType(request);

    const transport = parsePasskeyResponseBody(request.body);
    const credential = parseUntrusted(PasskeyCeremonyVerifyRequestSchema, transport.credential);
    const responseBody: ParsedPasskeyResponseBody = Object.freeze({
      credential,
      byteLength: transport.byteLength,
      digest: transport.digest
    });
    const response = parseTrusted(PasskeyCeremonyVerifyResponseSchema,
      await dependencies.service.verify(request.auth, {
        ceremonyId,
        commandId,
        expectedRevision,
        response: responseBody
      })
    );
    return sendCeremonyResponse(reply, response);
  });

  registeredInstances.add(app);
}
