import { createHash } from "node:crypto";
import { PASSKEY_MAX_RESPONSE_BYTES } from "@luxora/passkey-domain";
import { PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES } from "@luxora/protocol";
import type { FastifyInstance } from "fastify";
import { badRequest } from "../errors.js";

export const PASSKEY_RESPONSE_CONTENT_TYPE = "application/webauthn+json" as const;

export interface ParsedPasskeyResponseBody {
  /** The opaque parsed credential passed only to the maintained verifier. */
  readonly credential: Record<string, unknown>;
  /** Size of the exact bytes accepted at the HTTP boundary. */
  readonly byteLength: number;
  /** Lower-case SHA-256 of the exact accepted bytes. */
  readonly digest: string;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const parserOwners = new WeakSet<FastifyInstance>();

/** Installs the one audited raw WebAuthn parser shared by every passkey route family. */
export function ensurePasskeyResponseContentParser(app: FastifyInstance): void {
  if (parserOwners.has(app)) return;
  if (app.hasContentTypeParser(PASSKEY_RESPONSE_CONTENT_TYPE)) {
    throw new Error("A WebAuthn response content parser is already registered");
  }
  app.addContentTypeParser(PASSKEY_RESPONSE_CONTENT_TYPE, {
    parseAs: "buffer",
    bodyLimit: PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES
  }, (_request, body, done) => {
    done(null, body);
  });
  parserOwners.add(app);
}

/**
 * Parses the dedicated, bounded WebAuthn media type without reserializing the
 * credential. The byte length and digest are server-derived before JSON
 * parsing and are safe to use in the ceremony command fingerprint. Neither
 * the bytes nor the parsed credential may be logged by callers.
 */
export function parsePasskeyResponseBody(body: unknown): ParsedPasskeyResponseBody {
  if (!Buffer.isBuffer(body) || body.byteLength < 1 || body.byteLength > PASSKEY_MAX_RESPONSE_BYTES) {
    throw badRequest("Malformed WebAuthn response");
  }

  const byteLength = body.byteLength;
  const digest = createHash("sha256").update(body).digest("hex");
  let decoded: string;
  try {
    decoded = strictUtf8.decode(body);
  } catch {
    throw badRequest("Malformed WebAuthn response");
  }

  let credential: unknown;
  try {
    credential = JSON.parse(decoded) as unknown;
  } catch {
    throw badRequest("Malformed WebAuthn response");
  }
  if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
    throw badRequest("Malformed WebAuthn response");
  }

  return Object.freeze({
    credential: credential as Record<string, unknown>,
    byteLength,
    digest
  });
}
