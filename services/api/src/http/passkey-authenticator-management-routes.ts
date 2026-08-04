import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onSendHookHandler
} from "fastify";
import {
  BeginPasskeyAuthenticatorRevokeStepUpRequestSchema,
  PASSKEY_STEP_UP_AUTHORIZATION_HEADER,
  PasskeyAuthenticatorEtagSchema,
  PasskeyAuthenticatorListResponseSchema,
  PasskeyAuthenticatorMutationResponseSchema,
  PasskeyAuthenticatorParamsSchema,
  PasskeyAuthenticatorRenameRequestSchema,
  PasskeyAuthenticatorRevokeRequestSchema,
  PasskeyAuthenticatorRevokeStepUpBeginResponseSchema,
  PasskeyIdempotencyKeySchema,
  PasskeyStepUpAuthorizationHeaderSchema,
  type PasskeyAuthenticatorListResponse,
  type PasskeyAuthenticatorMutationResponse,
  type PasskeyAuthenticatorRevokeStepUpBeginResponse
} from "@luxora/protocol";

import type { AuthenticatedPrincipal } from "../domain/types.js";
import { AppError, badRequest } from "../errors.js";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const IF_MATCH_HEADER = "If-Match";
const registeredInstances = new WeakSet<FastifyInstance>();

interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export interface PasskeyAuthenticatorCeremonyRouteService {
  beginAuthenticatorRevokeStepUp(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly clientNonce: string;
      readonly credentialRecordId: string;
      readonly expectedRevision: number;
    }
  ): Promise<PasskeyAuthenticatorRevokeStepUpBeginResponse>;
}

export interface PasskeyAuthenticatorManagementRouteService {
  list(principal: AuthenticatedPrincipal): Promise<PasskeyAuthenticatorListResponse>;
  rename(
    principal: AuthenticatedPrincipal,
    input: {
      readonly commandId: string;
      readonly credentialRecordId: string;
      readonly displayName: string;
      readonly expectedRevision: number;
    }
  ): Promise<PasskeyAuthenticatorMutationResponse>;
  revoke(
    principal: AuthenticatedPrincipal,
    input: {
      readonly authenticationCeremonyId: string;
      readonly commandId: string;
      readonly credentialRecordId: string;
      readonly expectedRevision: number;
      readonly stepUpToken: string;
    }
  ): Promise<PasskeyAuthenticatorMutationResponse>;
}

export interface PasskeyAuthenticatorManagementRouteDependencies {
  readonly ceremonies: PasskeyAuthenticatorCeremonyRouteService;
  readonly management: PasskeyAuthenticatorManagementRouteService;
  readonly authGuard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  const normalizedValue = request.headers[normalizedName];
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || typeof normalizedValue !== "string"
    || value.includes(",")
    || normalizedValue.includes(",")
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
  if (!parsed.success) throw badRequest("Invalid authenticator management request");
  return parsed.data;
}

function parseTrusted<T>(schema: SafeParser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, "INTERNAL_ERROR", "Authenticator management response validation failed");
  }
  return parsed.data;
}

function expectedResourceRevision(request: FastifyRequest, authenticatorId: string): number {
  const value = parseHeader(request, IF_MATCH_HEADER, PasskeyAuthenticatorEtagSchema);
  const match = /^"passkey-authenticator:([0-9a-f-]{36}):rev:([1-9][0-9]*)"$/u.exec(value);
  const revision = match === null ? Number.NaN : Number(match[2]);
  if (match?.[1] !== authenticatorId || !Number.isSafeInteger(revision)) {
    throw badRequest(`Invalid ${IF_MATCH_HEADER} header`);
  }
  return revision;
}

function privateNoStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "private, no-store").header("pragma", "no-cache");
}

const privateNoStoreHook: onSendHookHandler = async (_request, reply, payload) => {
  privateNoStore(reply);
  return payload;
};

export function registerPasskeyAuthenticatorManagementRoutes(
  app: FastifyInstance,
  dependencies: PasskeyAuthenticatorManagementRouteDependencies
): void {
  if (registeredInstances.has(app)) {
    throw new Error("Passkey authenticator management routes are already registered");
  }

  app.post("/v1/auth/passkey-ceremonies/authenticator-revocation", {
    onRequest: dependencies.authGuard,
    onSend: privateNoStoreHook
  }, async (request, reply) => {
    const body = parseUntrusted(BeginPasskeyAuthenticatorRevokeStepUpRequestSchema, request.body);
    const commandId = parseHeader(request, IDEMPOTENCY_KEY_HEADER, PasskeyIdempotencyKeySchema);
    const response = parseTrusted(
      PasskeyAuthenticatorRevokeStepUpBeginResponseSchema,
      await dependencies.ceremonies.beginAuthenticatorRevokeStepUp(request.auth, {
        commandId,
        clientNonce: body.clientNonce,
        credentialRecordId: body.credentialRecordId,
        expectedRevision: body.expectedRevision
      })
    );
    return privateNoStore(reply)
      .header("etag", `"${response.ceremony.revision}"`)
      .code(200)
      .send(response);
  });

  app.get("/v1/auth/authenticators", {
    onRequest: dependencies.authGuard,
    onSend: privateNoStoreHook
  }, async (request, reply) => {
    const response = parseTrusted(
      PasskeyAuthenticatorListResponseSchema,
      await dependencies.management.list(request.auth)
    );
    return privateNoStore(reply).code(200).send(response);
  });

  app.patch("/v1/auth/authenticators/:authenticatorId", {
    onRequest: dependencies.authGuard,
    onSend: privateNoStoreHook
  }, async (request, reply) => {
    const { authenticatorId } = parseUntrusted(PasskeyAuthenticatorParamsSchema, request.params);
    const body = parseUntrusted(PasskeyAuthenticatorRenameRequestSchema, request.body);
    const commandId = parseHeader(request, IDEMPOTENCY_KEY_HEADER, PasskeyIdempotencyKeySchema);
    const expectedRevision = expectedResourceRevision(request, authenticatorId);
    const response = parseTrusted(
      PasskeyAuthenticatorMutationResponseSchema,
      await dependencies.management.rename(request.auth, {
        commandId,
        credentialRecordId: authenticatorId,
        displayName: body.displayName,
        expectedRevision
      })
    );
    return privateNoStore(reply)
      .header("etag", response.authenticator.etag)
      .code(200)
      .send(response);
  });

  app.delete("/v1/auth/authenticators/:authenticatorId", {
    onRequest: dependencies.authGuard,
    onSend: privateNoStoreHook
  }, async (request, reply) => {
    const { authenticatorId } = parseUntrusted(PasskeyAuthenticatorParamsSchema, request.params);
    const body = parseUntrusted(PasskeyAuthenticatorRevokeRequestSchema, request.body);
    const commandId = parseHeader(request, IDEMPOTENCY_KEY_HEADER, PasskeyIdempotencyKeySchema);
    const expectedRevision = expectedResourceRevision(request, authenticatorId);
    const stepUpToken = parseHeader(
      request,
      PASSKEY_STEP_UP_AUTHORIZATION_HEADER,
      PasskeyStepUpAuthorizationHeaderSchema
    );
    const response = parseTrusted(
      PasskeyAuthenticatorMutationResponseSchema,
      await dependencies.management.revoke(request.auth, {
        authenticationCeremonyId: body.authenticationCeremonyId,
        commandId,
        credentialRecordId: authenticatorId,
        expectedRevision,
        stepUpToken
      })
    );
    return privateNoStore(reply)
      .header("etag", response.authenticator.etag)
      .code(200)
      .send(response);
  });

  registeredInstances.add(app);
}
