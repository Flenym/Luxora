import {
  PASSKEY_DEFAULT_TIMEOUT_MS,
  PASSKEY_DOMAIN_VERSION,
  PASSKEY_MAX_RESPONSE_BYTES,
  type PasskeyRelyingPartyPolicy
} from "./types.js";
import { assertPolicy } from "./validation.js";

export const LUXORA_PASSKEY_RP_ID = "auth.luxora.app" as const;
export const LUXORA_PASSKEY_PRODUCTION_ORIGIN = "https://auth.luxora.app" as const;

export function createLuxoraPasskeyPolicy(input: {
  /** Environments use separate explicit lists and credential namespaces. */
  readonly allowedOrigins?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxResponseBytes?: number;
} = {}): PasskeyRelyingPartyPolicy {
  const policy: PasskeyRelyingPartyPolicy = {
    policyVersion: PASSKEY_DOMAIN_VERSION,
    rpId: LUXORA_PASSKEY_RP_ID,
    allowedOrigins: Object.freeze([...(input.allowedOrigins ?? [LUXORA_PASSKEY_PRODUCTION_ORIGIN])]),
    timeoutMs: input.timeoutMs ?? PASSKEY_DEFAULT_TIMEOUT_MS,
    maxAttempts: input.maxAttempts ?? 3,
    maxResponseBytes: input.maxResponseBytes ?? PASSKEY_MAX_RESPONSE_BYTES,
    userVerification: "required",
    userPresenceRequired: true,
    crossOriginAllowed: false,
    expectedTopOrigins: [],
    attestation: "none",
    registrationResidentKey: "required",
    allowedAlgorithms: Object.freeze([-7, -257])
  };
  assertPolicy(policy);
  return Object.freeze(policy);
}
