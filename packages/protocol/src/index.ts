import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const IDENTITY_ACCESS_CONTRACT_VERSION = 1 as const;
export const IA1_PROTOCOL_VERSION = 2 as const;
export const RELEASE_LABEL = "Beta-0.1" as const;
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_DRAFT_LENGTH = MAX_MESSAGE_LENGTH;
export const CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS = 2_048;
export const MAX_MESSAGE_REQUEST_LENGTH = 1_000;
export const MAX_CHAT_TITLE_LENGTH = 120;
export const MAX_CHAT_FOLDERS = 10;
export const MAX_CHAT_FOLDER_TITLE_LENGTH = 48;
export const MAX_CHAT_FOLDER_OVERRIDES = 100;
export const CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS = 64;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_SAFETY_REPORT_COMMENT_LENGTH = 2_000;
export const MAX_SAFETY_REPORT_EVIDENCE = 20;
export const REALTIME_MAX_REPLAY_EVENTS = 500;
export const REALTIME_CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CAPABILITIES_SCHEMA_VERSION = 1 as const;
export const HTTP_API_VERSION = 1 as const;
export const RECONCILIATION_API_VERSION = 2 as const;
export const REALTIME_PREFERRED_PROTOCOL_VERSION = IA1_PROTOCOL_VERSION;
export const REALTIME_MINIMUM_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

// UUID text is case-insensitive, but every Luxora boundary emits and compares
// one canonical representation. This prevents path, cursor, and idempotency
// aliases from becoming distinct application resources.
const RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const IdSchema = z.string()
  .uuid()
  .regex(RFC_UUID_PATTERN, "Expected an RFC UUID with a version and variant")
  .transform((value) => value.toLowerCase());
export const TimestampSchema = z.string().datetime({ offset: true });
export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Username must start with a letter and contain only letters, numbers, or underscores");
export const PasswordSchema = z.string().min(12).max(128);

export const ApiErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "PHONE_AUTH_CODE_INVALID",
  "PHONE_AUTH_ATTEMPTS_EXHAUSTED",
  "PHONE_AUTH_CHALLENGE_EXPIRED",
  "PHONE_AUTH_CHALLENGE_INVALID",
  "PHONE_AUTH_RESEND_COOLDOWN",
  "PHONE_AUTH_DELIVERY_UNAVAILABLE",
  "PHONE_AUTH_TEMPORARILY_UNAVAILABLE",
  "PHONE_AUTH_REGISTRATION_EXPIRED",
  "PHONE_AUTH_PASSWORD_INVALID",
  "PHONE_AUTH_PASSWORD_ATTEMPTS_EXHAUSTED",
  "PHONE_AUTH_PASSWORD_TOKEN_INVALID",
  "PHONE_AUTH_RECOVERY_TOKEN_INVALID",
  "PHONE_AUTH_RECOVERY_NOT_CONFIRMABLE",
  "PHONE_AUTH_BINDING_CHALLENGE_INVALID",
  "PHONE_AUTH_BINDING_TOKEN_INVALID"
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.unknown()).optional()
  })
});

export const UserSchema = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string(),
  bio: z.string(),
  avatarUrl: z.string().url().nullable(),
  avatarPath: z.string().startsWith("/v1/attachments/").nullable().optional(),
  createdAt: TimestampSchema,
  presence: z.enum(["online", "offline"]).optional(),
  lastSeenAt: TimestampSchema.nullable().optional()
});

export const PatchCurrentUserSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH).optional(),
  bio: z.string().trim().max(500).optional()
}).strict().refine(
  (value) => value.displayName !== undefined || value.bio !== undefined,
  { message: "At least one profile field must be changed" }
);

export const SetProfileAvatarSchema = z.object({
  attachmentId: IdSchema
}).strict();

// Stranger-facing identity is deliberately narrower than UserSchema. In
// particular, it has no presence, last-seen, identifier, session, or graph
// fields. Services must also apply the requester's privacy/block policy before
// constructing this projection.
export const PublicProfileSchema = z.object({
  id: IdSchema,
  username: UsernameSchema,
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  bio: z.string().max(500),
  avatarUrl: z.string().url().nullable(),
  avatarPath: z.string().startsWith("/v1/attachments/").nullable().optional(),
  lastSeenAt: TimestampSchema.nullable().optional()
}).strict();

export const UserLookupResponseSchema = z.object({
  profile: PublicProfileSchema.nullable()
}).strict();

export const MessageRequestPolicySchema = z.enum(["everyone", "nobody"]);

export const PrivacyVisibilitySchema = z.enum(["everyone", "contacts", "nobody"]);

export const PrivacySettingsSchema = z.object({
  usernameDiscoverable: z.boolean(),
  messageRequests: MessageRequestPolicySchema,
  lastSeen: PrivacyVisibilitySchema,
  profilePhoto: PrivacyVisibilitySchema,
  forwards: PrivacyVisibilitySchema,
  voiceMessages: PrivacyVisibilitySchema,
  calls: PrivacyVisibilitySchema
}).strict();

export const PatchPrivacySettingsSchema = z.object({
  usernameDiscoverable: z.boolean().optional(),
  messageRequests: MessageRequestPolicySchema.optional(),
  lastSeen: PrivacyVisibilitySchema.optional(),
  profilePhoto: PrivacyVisibilitySchema.optional(),
  forwards: PrivacyVisibilitySchema.optional(),
  voiceMessages: PrivacyVisibilitySchema.optional(),
  calls: PrivacyVisibilitySchema.optional()
}).strict().refine(
  (value) => value.usernameDiscoverable !== undefined
    || value.messageRequests !== undefined
    || value.lastSeen !== undefined
    || value.profilePhoto !== undefined
    || value.forwards !== undefined
    || value.voiceMessages !== undefined
    || value.calls !== undefined,
  { message: "At least one privacy setting must be changed" }
);

export const PushPlatformSchema = z.literal("apns");
export const PushEnvironmentSchema = z.enum(["development", "production"]);
export const PushTopicSchema = z.literal("app.luxora.mobile");
export const APNSDeviceTokenSchema = z.string()
  .trim()
  // APNs tokens are opaque and their byte length must not be hard-coded. The
  // client transports Apple's bytes as bounded hexadecimal text; even length
  // preserves whole bytes while the generous upper bound limits abuse.
  .regex(/^[0-9a-fA-F]{32,1024}$/u, "APNs token must be bounded hexadecimal bytes")
  .refine((value) => value.length % 2 === 0, "APNs token must contain complete bytes")
  .transform((value) => value.toLowerCase());

export const UpsertPushRegistrationSchema = z.object({
  platform: PushPlatformSchema,
  environment: PushEnvironmentSchema,
  token: APNSDeviceTokenSchema
}).strict();

export const PushRegistrationSchema = z.object({
  id: IdSchema,
  platform: PushPlatformSchema,
  environment: PushEnvironmentSchema,
  topic: PushTopicSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
}).strict();

export const NotificationPreviewModeSchema = z.enum(["hidden", "sender", "full"]);
export const NotificationSettingsSchema = z.object({
  messageAlerts: z.boolean(),
  messageRequestAlerts: z.boolean(),
  mentionAlerts: z.boolean(),
  groupAlerts: z.boolean().default(true),
  channelAlerts: z.boolean().default(true),
  storyAlerts: z.boolean().default(true),
  reactionAlerts: z.boolean().default(true),
  sound: z.boolean(),
  badge: z.boolean(),
  previewMode: NotificationPreviewModeSchema,
  updatedAt: TimestampSchema
}).strict();

export const PatchNotificationSettingsSchema = z.object({
  messageAlerts: z.boolean().optional(),
  messageRequestAlerts: z.boolean().optional(),
  mentionAlerts: z.boolean().optional(),
  groupAlerts: z.boolean().optional(),
  channelAlerts: z.boolean().optional(),
  storyAlerts: z.boolean().optional(),
  reactionAlerts: z.boolean().optional(),
  sound: z.boolean().optional(),
  badge: z.boolean().optional(),
  previewMode: NotificationPreviewModeSchema.optional()
}).strict().refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: "At least one notification setting must be changed" }
);

export const SessionSchema = z.object({
  id: IdSchema,
  deviceName: z.string(),
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  expiresAt: TimestampSchema,
  current: z.boolean()
});

export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  password: PasswordSchema,
  deviceName: z.string().trim().min(1).max(120).default("Unknown device")
}).strict();

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1).max(128),
  deviceName: z.string().trim().min(1).max(120).default("Unknown device")
}).strict();

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(40).max(512)
}).strict();

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  sessionId: IdSchema
});

export const AuthResponseSchema = z.object({
  user: UserSchema,
  tokens: AuthTokensSchema
});

// Security containment (IDENTITY_ACCESS §11), first slice: session,
// all_other_sessions and account scopes. recovery_takeover arrives with the
// recovery review flow and is not accepted yet.
export const ContainmentScopeSchema = z.enum(["session", "all_other_sessions", "account"]);

export const ContainmentRequestSchema = z.object({
  scope: ContainmentScopeSchema,
  sessionId: IdSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.scope === "session" && value.sessionId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "session scope requires sessionId",
      path: ["sessionId"]
    });
  }
  if (value.scope !== "session" && value.sessionId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sessionId is only valid for the session scope",
      path: ["sessionId"]
    });
  }
});

export const ContainmentResponseSchema = z.object({
  scope: ContainmentScopeSchema,
  revokedSessionIds: z.array(IdSchema)
});

export const PHONE_AUTH_CODE_LENGTH = 6;
export const PhoneCountryCallingCodeSchema = z.string()
  .regex(/^[1-9][0-9]{0,2}$/u, "Country calling code must contain 1-3 digits without '+'");
export const PhoneNationalNumberSchema = z.string()
  .regex(/^[0-9]{4,14}$/u, "National number must contain 4-14 digits");
export const PhoneVerificationCodeSchema = z.string()
  .regex(/^[0-9]{6}$/u, "Verification code must contain exactly 6 digits");
export const PhoneRegistrationTokenSchema = z.string()
  .regex(/^luxpr_[A-Za-z0-9_-]{43}$/u, "Invalid phone registration token");
export const PhonePasswordTokenSchema = z.string()
  .regex(/^luxpw_[A-Za-z0-9_-]{43}$/u, "Invalid phone password token");
export const PhoneRecoveryTokenSchema = z.string()
  .regex(/^luxrc_[A-Za-z0-9_-]{43}$/u, "Invalid phone recovery token");
export const PhoneBindingTokenSchema = z.string()
  .regex(/^luxbt_[A-Za-z0-9_-]{43}$/u, "Invalid phone binding token");

export const RequestPhoneChallengeSchema = z.object({
  countryCode: PhoneCountryCallingCodeSchema,
  nationalNumber: PhoneNationalNumberSchema,
  deviceName: z.string().trim().min(1).max(120).default("Unknown device"),
  clientNonce: IdSchema
}).strict().superRefine((value, context) => {
  const totalDigits = value.countryCode.length + value.nationalNumber.length;
  if (totalDigits < 7 || totalDigits > 15) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Phone number must contain 7-15 E.164 digits",
      path: ["nationalNumber"]
    });
  }
});

export const PhoneChallengeResponseSchema = z.object({
  challengeId: IdSchema,
  maskedPhone: z.string().min(4).max(40),
  expiresAt: TimestampSchema,
  retryAfterSeconds: z.number().int().nonnegative().max(3_600)
}).strict();

export const VerifyPhoneChallengeSchema = z.object({
  code: PhoneVerificationCodeSchema,
  deviceName: z.string().trim().min(1).max(120).default("Unknown device"),
  clientNonce: IdSchema
}).strict();

export const PhoneAuthenticatedResponseSchema = z.object({
  status: z.literal("authenticated"),
  user: UserSchema,
  tokens: AuthTokensSchema
}).strict();

export const PhoneProfileRequiredResponseSchema = z.object({
  status: z.literal("profile_required"),
  registrationToken: PhoneRegistrationTokenSchema,
  maskedPhone: z.string().min(4).max(40),
  expiresAt: TimestampSchema
}).strict();

export const PhonePasswordRequiredResponseSchema = z.object({
  status: z.literal("password_required"),
  passwordToken: PhonePasswordTokenSchema,
  maskedPhone: z.string().min(4).max(40),
  expiresAt: TimestampSchema
}).strict();

export const PhoneBindingVerifiedResponseSchema = z.object({
  status: z.literal("binding_verified"),
  bindingToken: PhoneBindingTokenSchema,
  maskedPhone: z.string().min(4).max(40),
  expiresAt: TimestampSchema
}).strict();

export const VerifyPhoneChallengeResponseSchema = z.discriminatedUnion("status", [
  PhoneAuthenticatedResponseSchema,
  PhoneProfileRequiredResponseSchema,
  PhonePasswordRequiredResponseSchema,
  PhoneBindingVerifiedResponseSchema
]);

export const CompletePhonePasswordChallengeSchema = z.object({
  passwordToken: PhonePasswordTokenSchema,
  password: z.string().min(1).max(128),
  deviceName: z.string().trim().min(1).max(120).default("Unknown device"),
  clientNonce: IdSchema
}).strict();

export const ConfigurePhonePasswordSchema = z.object({
  password: PasswordSchema,
  currentPassword: z.string().min(1).max(128).optional()
}).strict();

export const DisablePhonePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128)
}).strict();

export const PhonePasswordStatusSchema = z.object({
  eligible: z.boolean(),
  enabled: z.boolean()
}).strict().refine((value) => !value.enabled || value.eligible, {
  message: "Phone password cannot be enabled without a verified phone identity"
});

export const CompletePhoneRegistrationSchema = z.object({
  registrationToken: PhoneRegistrationTokenSchema,
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  username: UsernameSchema,
  bio: z.string().trim().max(500).default(""),
  deviceName: z.string().trim().min(1).max(120).default("Unknown device"),
  clientNonce: IdSchema
}).strict();

export const CheckPhoneUsernameSchema = z.object({
  registrationToken: PhoneRegistrationTokenSchema,
  username: UsernameSchema
}).strict();

export const PhoneUsernameAvailabilityResponseSchema = z.object({
  username: UsernameSchema,
  available: z.boolean(),
  suggestions: z.array(UsernameSchema).max(5)
}).strict().superRefine((value, context) => {
  if (value.available && value.suggestions.length !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Available usernames must not include alternatives",
      path: ["suggestions"]
    });
  }
});

export const StartPhoneRecoverySchema = z.object({
  passwordToken: PhonePasswordTokenSchema,
  clientNonce: IdSchema
}).strict();

export const PhoneRecoveryStartedResponseSchema = z.object({
  recoveryToken: PhoneRecoveryTokenSchema,
  maskedPhone: z.string().min(4).max(40),
  confirmAt: TimestampSchema,
  expiresAt: TimestampSchema
}).strict();

export const CompletePhoneRecoverySchema = z.object({
  recoveryToken: PhoneRecoveryTokenSchema,
  password: PasswordSchema,
  deviceName: z.string().trim().min(1).max(120).default("Unknown device"),
  clientNonce: IdSchema
}).strict();

export const StartPhoneBindingSchema = z.object({
  countryCode: PhoneCountryCallingCodeSchema,
  nationalNumber: PhoneNationalNumberSchema,
  deviceName: z.string().trim().min(1).max(120).default("Unknown device"),
  clientNonce: IdSchema
}).strict().superRefine((value, context) => {
  const totalDigits = value.countryCode.length + value.nationalNumber.length;
  if (totalDigits < 7 || totalDigits > 15) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Phone number must contain 7-15 E.164 digits",
      path: ["nationalNumber"]
    });
  }
});

export const PhoneBindingChallengeResponseSchema = z.object({
  challengeId: IdSchema,
  maskedPhone: z.string().min(4).max(40),
  expiresAt: TimestampSchema,
  retryAfterSeconds: z.number().int().nonnegative().max(3_600)
}).strict();

export const CompletePhoneBindingSchema = z.object({
  bindingToken: PhoneBindingTokenSchema,
  clientNonce: IdSchema
}).strict();

export const PhoneBindingCompletedResponseSchema = z.object({
  phonePassword: PhonePasswordStatusSchema
}).strict();

// Passkey ceremony routes are a disabled, contract-only foundation. The API
// must keep capabilities.features.passkeys=false until storage, vault,
// maintained-verifier and end-to-end route evidence all pass.
export const PASSKEY_HTTP_CONTRACT_VERSION = 1 as const;
export const PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES = 65_536;
export const PASSKEY_MAX_EXTENSION_RESULTS_BYTES = 8_192;
export const PASSKEY_MAX_CREDENTIAL_ID_BASE64URL_LENGTH = 1_364;
export const PASSKEY_MAX_CREDENTIAL_ID_BYTES = 1_023;
export const PASSKEY_MAX_BINARY_BASE64URL_LENGTH = PASSKEY_MAX_CREDENTIAL_RESPONSE_BYTES;
export const PASSKEY_MAX_USER_HANDLE_BYTES = 64;
export const PASSKEY_CHALLENGE_BYTES = 32;
export const PASSKEY_DELIVERY_NONCE_BYTES = 32;
export const PASSKEY_DEFAULT_TIMEOUT_MS = 300_000;
export const PASSKEY_MAX_TIMEOUT_MS = 600_000;
export const PASSKEY_STEP_UP_TOKEN_MAX_BYTES = 4_096;
export const PASSKEY_STEP_UP_AUTHORIZATION_HEADER = "Step-Up-Authorization" as const;
export const PASSKEY_STEP_UP_AUTHORIZATION_SCHEME = "Bearer" as const;

// These paths describe the next, still-internal pre-authentication seam. Merely
// exporting a contract must never register the routes or advertise passkeys.
// Fixed verify paths preserve a raw WebAuthn credential body; a separately
// signed, purpose-bound Bootstrap-Authorization identifies the ceremony.
export const PASSKEY_INTERNAL_SIGNUP_OPTIONS_PATH = "/v1/auth/register/passkey/options" as const;
export const PASSKEY_INTERNAL_SIGNUP_VERIFY_PATH = "/v1/auth/register/passkey/verify" as const;
export const PASSKEY_INTERNAL_LOGIN_OPTIONS_PATH = "/v1/auth/passkeys/authentication/options" as const;
export const PASSKEY_INTERNAL_LOGIN_VERIFY_PATH = "/v1/auth/passkeys/authentication/verify" as const;
export const PASSKEY_BOOTSTRAP_AUTHORIZATION_HEADER = "Bootstrap-Authorization" as const;
export const PASSKEY_BOOTSTRAP_AUTHORIZATION_SCHEME = "Bearer" as const;
export const PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES = 4_096;

const PasskeyRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PasskeyAuthenticatorAttachmentSchema = z.enum(["platform", "cross-platform"]);
const PasskeyAuthenticatorTransportSchema = z.enum([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb"
]);

function decodedBase64UrlByteLength(value: string): number {
  const remainder = value.length % 4;
  if (remainder === 1) return Number.POSITIVE_INFINITY;
  return Math.floor((value.length * 3) / 4);
}

function isCanonicalUnpaddedBase64Url(value: string): boolean {
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 0) return true;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  if (lastIndex < 0) return false;
  return remainder === 2 ? lastIndex % 16 === 0 : lastIndex % 4 === 0;
}

function boundedBase64UrlSchema(maximumCharacters: number) {
  return z.string()
    .min(1)
    .max(maximumCharacters)
    .regex(/^[A-Za-z0-9_-]+$/u, "Expected canonical unpadded base64url")
    .refine(isCanonicalUnpaddedBase64Url, "Expected canonical unpadded base64url");
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function isBoundedExtensionValue(value: unknown, depth: number): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Number.isSafeInteger(value);
  if (typeof value === "string") return value.length <= PASSKEY_MAX_EXTENSION_RESULTS_BYTES;
  if (Array.isArray(value)) {
    return value.length <= 32 && value.every((item) => isBoundedExtensionValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
  ) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 32 && entries.every(([key, item]) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key)
    && key !== "__proto__"
    && key !== "constructor"
    && key !== "prototype"
    && isBoundedExtensionValue(item, depth + 1)
  );
}

export const PasskeyBase64UrlSchema = boundedBase64UrlSchema(
  PASSKEY_MAX_BINARY_BASE64URL_LENGTH
);

export const PasskeyChallengeSchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine(
    isCanonicalUnpaddedBase64Url,
    "Passkey challenge must be canonical unpadded base64url for exactly 32 bytes"
  );

export const PasskeyDeliveryNonceSchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine(
    isCanonicalUnpaddedBase64Url,
    "Passkey delivery nonce must be canonical unpadded base64url for exactly 32 bytes"
  );

export const PasskeyUserHandleSchema = boundedBase64UrlSchema(86).refine(
  (value) => decodedBase64UrlByteLength(value) <= PASSKEY_MAX_USER_HANDLE_BYTES,
  "Passkey user handle exceeds 64 decoded bytes"
);

export const PasskeyCredentialIdSchema = boundedBase64UrlSchema(
  PASSKEY_MAX_CREDENTIAL_ID_BASE64URL_LENGTH
).refine(
  (value) => decodedBase64UrlByteLength(value) <= PASSKEY_MAX_CREDENTIAL_ID_BYTES,
  "Passkey credential ID exceeds 1023 decoded bytes"
);

export const PasskeyClientExtensionResultsSchema = z.unknown().superRefine(
  (value, context) => {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || !isBoundedExtensionValue(value, 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "WebAuthn extension results exceed structural bounds"
      });
      return;
    }
    const serialized = JSON.stringify(value);
    if (utf8ByteLength(serialized) > PASSKEY_MAX_EXTENSION_RESULTS_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: PASSKEY_MAX_EXTENSION_RESULTS_BYTES,
        inclusive: true,
        type: "string",
        message: "WebAuthn extension results exceed the byte limit"
      });
    }
  }
).transform((value) => value as Record<string, unknown>);

export const PasskeyIdempotencyKeySchema = IdSchema;

export const PasskeyCeremonyRevisionETagSchema = z.string()
  .regex(/^"(?:0|[1-9][0-9]{0,15})"$/u, "If-Match must contain one canonical quoted revision")
  .transform((value, context) => {
    const revision = Number(value.slice(1, -1));
    if (!Number.isSafeInteger(revision)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Revision exceeds safe integer range" });
      return z.NEVER;
    }
    return revision;
  });

export const PasskeyCredentialContentTypeSchema = z.string()
  .trim()
  .regex(
    /^application\/webauthn\+json(?:\s*;\s*charset=utf-8)?$/iu,
    "Passkey verification requires application/webauthn+json"
  )
  .transform(() => "application/webauthn+json" as const);

export const PasskeyCeremonyParamsSchema = z.object({
  ceremonyId: IdSchema
}).strict();

export const BeginPasskeyRegistrationRequestSchema = z.object({
  clientNonce: IdSchema,
  // The short-lived authorization is transported in a separate no-store
  // header. Keeping its ceremony ID in the strict body lets the server verify
  // the token against an explicit caller-supplied binding without decoding an
  // untrusted JWT merely to discover a repository key.
  stepUpCeremonyId: IdSchema
}).strict();

export const PasskeyStepUpOperationSchema = z.union([
  z.literal("authenticator.add"),
  z.literal("device-link.approve")
]);

export const BeginPasskeyStepUpRequestSchema = z.object({
  clientNonce: IdSchema,
  operation: PasskeyStepUpOperationSchema,
  linkId: IdSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.operation === "device-link.approve" && value.linkId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "device-link.approve requires linkId",
      path: ["linkId"]
    });
  }
  if (value.operation !== "device-link.approve" && value.linkId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "linkId is only valid for device-link.approve",
      path: ["linkId"]
    });
  }
});

export const PasskeyAuthenticatorRevokeOperationSchema = z.literal("authenticator.revoke");
export const BeginPasskeyAuthenticatorRevokeStepUpRequestSchema = z.object({
  clientNonce: IdSchema,
  credentialRecordId: IdSchema,
  expectedRevision: PasskeyRevisionSchema.min(1)
}).strict();

export const PasskeyAuthenticatorRevokeTargetBindingSchema = z.object({
  accountId: IdSchema,
  sessionId: IdSchema,
  credentialRecordId: IdSchema,
  expectedRevision: PasskeyRevisionSchema.min(1),
  targetDigest: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

const PasskeyAuthenticatorTransportsSchema = z.array(PasskeyAuthenticatorTransportSchema).max(7)
  .refine((values) => new Set(values).size === values.length, "Duplicate authenticator transport");

export const PasskeyCredentialDescriptorSchema = z.object({
  id: PasskeyCredentialIdSchema,
  type: z.literal("public-key"),
  transports: PasskeyAuthenticatorTransportsSchema.optional()
});

const PasskeyRegistrationResponseDataSchema = z.object({
  clientDataJSON: PasskeyBase64UrlSchema,
  attestationObject: PasskeyBase64UrlSchema,
  transports: PasskeyAuthenticatorTransportsSchema.optional(),
  publicKeyAlgorithm: z.union([z.literal(-7), z.literal(-257)]).optional(),
  publicKey: PasskeyBase64UrlSchema.optional(),
  authenticatorData: PasskeyBase64UrlSchema.optional()
}).strict();

const PasskeyAuthenticationResponseDataSchema = z.object({
  clientDataJSON: PasskeyBase64UrlSchema,
  authenticatorData: PasskeyBase64UrlSchema,
  signature: PasskeyBase64UrlSchema,
  // CURRENT HTTP authentication is discoverable-only (no allowCredentials),
  // so WebAuthn requires a non-empty, PII-free user handle in the assertion.
  userHandle: PasskeyUserHandleSchema
}).strict();

function credentialIdsMatch(value: { id: string; rawId: string }): boolean {
  return value.id === value.rawId;
}

export const PasskeyRegistrationCredentialJSONSchema = z.object({
  id: PasskeyCredentialIdSchema,
  rawId: PasskeyCredentialIdSchema,
  response: PasskeyRegistrationResponseDataSchema,
  authenticatorAttachment: PasskeyAuthenticatorAttachmentSchema.optional(),
  clientExtensionResults: PasskeyClientExtensionResultsSchema,
  type: z.literal("public-key")
}).strict().refine(credentialIdsMatch, {
  message: "WebAuthn id must equal the base64url encoding of rawId",
  path: ["rawId"]
});

export const PasskeyAuthenticationCredentialJSONSchema = z.object({
  id: PasskeyCredentialIdSchema,
  rawId: PasskeyCredentialIdSchema,
  response: PasskeyAuthenticationResponseDataSchema,
  authenticatorAttachment: PasskeyAuthenticatorAttachmentSchema.optional(),
  clientExtensionResults: PasskeyClientExtensionResultsSchema,
  type: z.literal("public-key")
}).strict().refine(credentialIdsMatch, {
  message: "WebAuthn id must equal the base64url encoding of rawId",
  path: ["rawId"]
});

// This is the complete raw request body for the shared verify endpoint. The
// transport must retain its exact accepted bytes and compute byte length plus
// SHA-256 itself before parsing; neither value is accepted from the client.
export const PasskeyCeremonyVerifyRequestSchema = z.union([
  PasskeyRegistrationCredentialJSONSchema,
  PasskeyAuthenticationCredentialJSONSchema
]);

export const PasskeyCeremonyStateSchema = z.enum([
  "pending",
  "consumed",
  "cancelled",
  "expired",
  "rejected"
]);

const PasskeyCeremonyPublicBaseShape = {
  id: IdSchema,
  state: PasskeyCeremonyStateSchema,
  revision: PasskeyRevisionSchema,
  expiresAt: TimestampSchema
};

export const PasskeyRegistrationCeremonyPublicSchema = z.object({
  ...PasskeyCeremonyPublicBaseShape,
  kind: z.literal("registration"),
  purpose: z.literal("authenticator.add")
});

export const PasskeyAuthenticationCeremonyPublicSchema = z.object({
  ...PasskeyCeremonyPublicBaseShape,
  kind: z.literal("authentication"),
  purpose: z.literal("session.step_up")
});

export const PasskeyCeremonyPublicSchema = z.discriminatedUnion("kind", [
  PasskeyRegistrationCeremonyPublicSchema,
  PasskeyAuthenticationCeremonyPublicSchema
]);

function isCanonicalCompactJwt(value: string): boolean {
  const segments = value.split(".");
  return segments.length === 3
    && segments.every((segment) =>
      segment.length > 0
      && /^[A-Za-z0-9_-]+$/u.test(segment)
      && isCanonicalUnpaddedBase64Url(segment)
    );
}

export const PasskeyStepUpTokenSchema = z.string()
  .min(1)
  .max(PASSKEY_STEP_UP_TOKEN_MAX_BYTES)
  .refine(isCanonicalCompactJwt, "Expected a canonical compact step-up JWT");

export const PasskeyStepUpAuthorizationHeaderSchema = z.string()
  .max(PASSKEY_STEP_UP_AUTHORIZATION_SCHEME.length + 1 + PASSKEY_STEP_UP_TOKEN_MAX_BYTES)
  .regex(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
  .transform((value, context) => {
    const token = value.slice(PASSKEY_STEP_UP_AUTHORIZATION_SCHEME.length + 1);
    const parsed = PasskeyStepUpTokenSchema.safeParse(token);
    if (!parsed.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid step-up authorization"
      });
      return z.NEVER;
    }
    return parsed.data;
  });

export const PasskeyRegistrationOptionsSchema = z.object({
  challenge: PasskeyChallengeSchema,
  rp: z.object({
    id: z.literal("auth.luxora.app"),
    name: z.literal("Luxora")
  }),
  user: z.object({
    id: PasskeyUserHandleSchema,
    name: UsernameSchema,
    displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH)
  }),
  pubKeyCredParams: z.tuple([
    z.object({ type: z.literal("public-key"), alg: z.literal(-7) }),
    z.object({ type: z.literal("public-key"), alg: z.literal(-257) })
  ]),
  excludeCredentials: z.array(PasskeyCredentialDescriptorSchema).max(20)
    .refine(
      (descriptors) => new Set(descriptors.map(({ id }) => id)).size === descriptors.length,
      "Duplicate excluded credential ID"
    ),
  timeout: z.number().int().positive().max(PASSKEY_MAX_TIMEOUT_MS),
  attestation: z.literal("none"),
  authenticatorSelection: z.object({
    residentKey: z.literal("required"),
    requireResidentKey: z.literal(true),
    userVerification: z.literal("required")
  })
});

export const PasskeyStepUpOptionsSchema = z.object({
  challenge: PasskeyChallengeSchema,
  rpId: z.literal("auth.luxora.app"),
  timeout: z.number().int().positive().max(PASSKEY_MAX_TIMEOUT_MS),
  userVerification: z.literal("required"),
  allowCredentials: z.tuple([])
});

const PasskeyBeginResponseBaseShape = {
  schemaVersion: z.literal(PASSKEY_HTTP_CONTRACT_VERSION),
  ceremony: PasskeyCeremonyPublicSchema,
  // Added after the first contract fixture. It stays optional so a current
  // client can consume the one-generation-back v1 response fixture.
  replayed: z.boolean().optional()
};

export const PasskeyRegistrationBeginResponseSchema = z.object({
  ...PasskeyBeginResponseBaseShape,
  ceremony: PasskeyRegistrationCeremonyPublicSchema.extend({
    state: z.literal("pending")
  }),
  options: PasskeyRegistrationOptionsSchema
});

export const PasskeyStepUpBeginResponseSchema = z.object({
  ...PasskeyBeginResponseBaseShape,
  ceremony: PasskeyAuthenticationCeremonyPublicSchema.extend({
    state: z.literal("pending")
  }),
  operation: PasskeyStepUpOperationSchema,
  options: PasskeyStepUpOptionsSchema
});

export const PasskeyAuthenticatorRevokeStepUpBeginResponseSchema = z.object({
  ...PasskeyBeginResponseBaseShape,
  ceremony: PasskeyAuthenticationCeremonyPublicSchema.extend({
    state: z.literal("pending")
  }),
  operation: PasskeyAuthenticatorRevokeOperationSchema,
  targetBinding: PasskeyAuthenticatorRevokeTargetBindingSchema,
  options: PasskeyStepUpOptionsSchema
}).strict();

const PasskeyCeremonyVerifyResponseBaseShape = {
  schemaVersion: z.literal(PASSKEY_HTTP_CONTRACT_VERSION),
  verified: z.literal(true),
  replayed: z.boolean()
};

// Response readers intentionally strip future additive fields. The required
// literals and bounded token remain security-critical and are never optional.
export const PasskeyStepUpAuthorizationSchema = z.object({
  scheme: z.literal(PASSKEY_STEP_UP_AUTHORIZATION_SCHEME),
  token: PasskeyStepUpTokenSchema,
  purpose: PasskeyStepUpOperationSchema,
  expiresAt: TimestampSchema
});

export const PasskeyAuthenticatorRevokeAuthorizationSchema = z.object({
  scheme: z.literal(PASSKEY_STEP_UP_AUTHORIZATION_SCHEME),
  token: PasskeyStepUpTokenSchema,
  purpose: PasskeyAuthenticatorRevokeOperationSchema,
  expiresAt: TimestampSchema
}).strict();

export const PasskeyRegistrationVerifyResponseSchema = z.object({
  ...PasskeyCeremonyVerifyResponseBaseShape,
  ceremony: PasskeyRegistrationCeremonyPublicSchema.extend({ state: z.literal("consumed") })
});

export const PasskeyStepUpVerifyResponseSchema = z.object({
  ...PasskeyCeremonyVerifyResponseBaseShape,
  ceremony: PasskeyAuthenticationCeremonyPublicSchema.extend({ state: z.literal("consumed") }),
  stepUpAuthorization: PasskeyStepUpAuthorizationSchema
});

export const PasskeyAuthenticatorRevokeStepUpVerifyResponseSchema = z.object({
  ...PasskeyCeremonyVerifyResponseBaseShape,
  ceremony: PasskeyAuthenticationCeremonyPublicSchema.extend({ state: z.literal("consumed") }),
  stepUpAuthorization: PasskeyAuthenticatorRevokeAuthorizationSchema
});

export const PasskeyCeremonyVerifyResponseSchema = z.union([
  PasskeyRegistrationVerifyResponseSchema,
  PasskeyStepUpVerifyResponseSchema,
  PasskeyAuthenticatorRevokeStepUpVerifyResponseSchema
]);

export const PasskeyCeremonyErrorReasonSchema = z.enum([
  "step_up_required",
  "assurance_insufficient",
  "ceremony_unavailable",
  "challenge_expired",
  "ceremony_conflict",
  "verification_failed",
  "temporarily_unavailable"
]);

// Durable authenticator-management contract. Beta-0.1 may expose it only on
// the explicitly gated non-production passkey seam; public capability
// discovery remains false until the production release gates are satisfied.
export const PASSKEY_AUTHENTICATOR_MANAGEMENT_CONTRACT_VERSION = 1 as const;
export const PasskeyAuthenticatorLifecycleStateSchema = z.enum(["active", "revoked"]);
export const PasskeyAuthenticatorDisplayNameSchema = z.string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim() && value === value.normalize("NFC"))
  .refine((value) => utf8ByteLength(value) <= 256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
  .refine((value) => !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value));
export const PasskeyAuthenticatorEtagSchema = z.string()
  .regex(/^"passkey-authenticator:[0-9a-f-]{36}:rev:[1-9][0-9]*"$/u);
export const PasskeyAuthenticatorPublicSchema = z.object({
  id: IdSchema,
  displayName: PasskeyAuthenticatorDisplayNameSchema,
  state: PasskeyAuthenticatorLifecycleStateSchema,
  revision: PasskeyRevisionSchema,
  etag: PasskeyAuthenticatorEtagSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable()
}).strict().superRefine((value, context) => {
  const createdAtMs = Date.parse(value.createdAt);
  const updatedAtMs = Date.parse(value.updatedAt);
  const revokedAtMs = value.revokedAt === null ? null : Date.parse(value.revokedAt);
  if (value.etag !== `"passkey-authenticator:${value.id}:rev:${value.revision}"`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Authenticator ETag does not match its resource revision",
      path: ["etag"]
    });
  }
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs) || createdAtMs > updatedAtMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Authenticator timestamps are inconsistent",
      path: ["updatedAt"]
    });
  }
  if (
    (value.state === "active" && value.revokedAt !== null)
    || (value.state === "revoked"
      && (!Number.isFinite(revokedAtMs) || revokedAtMs !== updatedAtMs))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Authenticator lifecycle timestamps are inconsistent",
      path: ["revokedAt"]
    });
  }
});
export const PasskeyAuthenticatorListResponseSchema = z.object({
  schemaVersion: z.literal(PASSKEY_AUTHENTICATOR_MANAGEMENT_CONTRACT_VERSION),
  authenticators: z.array(PasskeyAuthenticatorPublicSchema).max(20)
}).strict();
export const PasskeyAuthenticatorMutationResponseSchema = z.object({
  schemaVersion: z.literal(PASSKEY_AUTHENTICATOR_MANAGEMENT_CONTRACT_VERSION),
  authenticator: PasskeyAuthenticatorPublicSchema,
  replayed: z.boolean()
}).strict();
export const PasskeyAuthenticatorParamsSchema = z.object({
  authenticatorId: IdSchema
}).strict();
export const PasskeyAuthenticatorRenameRequestSchema = z.object({
  displayName: PasskeyAuthenticatorDisplayNameSchema
}).strict();
export const PasskeyAuthenticatorRevokeRequestSchema = z.object({
  authenticationCeremonyId: IdSchema
}).strict();
// Passkey failures deliberately collapse verifier/challenge/credential detail.
// State and revision may appear only after the embedding service has already
// authorized the ceremony actor.
export const PasskeyCeremonyErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "BAD_REQUEST",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
      "VALIDATION_FAILED",
      "INTERNAL_ERROR",
      "SERVICE_UNAVAILABLE"
    ]),
    message: z.string(),
    requestId: z.string(),
    details: z.object({
      reason: PasskeyCeremonyErrorReasonSchema,
      state: PasskeyCeremonyStateSchema.optional(),
      revision: PasskeyRevisionSchema.optional()
    }).optional()
  })
});

// ---------------------------------------------------------------------------
// Internal passkey-first signup and identifier-free primary login contracts.
//
// This section is deliberately additive: the authenticated authenticator.add
// and session.step_up schemas above retain their exact v1 shapes. The API
// registers them only behind a non-production integration gate; public
// capability discovery remains false until the complete release gate passes.
// ---------------------------------------------------------------------------

export const BeginPasskeySignupRequestSchema = z.object({
  clientNonce: IdSchema,
  // Independent 256-bit client entropy binds exact response-loss recovery.
  // It is carried forward only by the signed bootstrap authorization and the
  // durable intent; verify keeps its raw WebAuthn credential body.
  deliveryNonce: PasskeyDeliveryNonceSchema,
  // Account uniqueness is lowercase ASCII. Canonicalizing before an eventual
  // command fingerprint prevents casing aliases from splitting idempotency.
  username: UsernameSchema.transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH)
    .transform((value) => value.normalize("NFC")),
  // The first passkey verification atomically creates this device session, so
  // its human-readable name is part of the signed signup authorization rather
  // than inferred from an unauthenticated User-Agent header.
  deviceName: z.string().trim().min(1).max(120)
    .transform((value) => value.normalize("NFC"))
}).strict();

// Primary passkey login is intentionally identifier-free. In particular this
// body cannot carry username, account ID, credential descriptors, or device
// claims. Device/session metadata belongs to a later independently reviewed
// transport contract.
export const BeginPasskeyLoginRequestSchema = z.object({
  clientNonce: IdSchema,
  deliveryNonce: PasskeyDeliveryNonceSchema
}).strict();

export const PasskeyBootstrapPurposeSchema = z.enum([
  "account.create",
  "session.create"
]);

export const PasskeyBootstrapTokenSchema = z.string()
  .min(1)
  .max(PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES)
  .refine(isCanonicalCompactJwt, "Expected a canonical compact bootstrap JWT");

export const PasskeyBootstrapAuthorizationHeaderSchema = z.string()
  .max(PASSKEY_BOOTSTRAP_AUTHORIZATION_SCHEME.length + 1 + PASSKEY_BOOTSTRAP_TOKEN_MAX_BYTES)
  .regex(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
  .transform((value, context) => {
    const token = value.slice(PASSKEY_BOOTSTRAP_AUTHORIZATION_SCHEME.length + 1);
    const parsed = PasskeyBootstrapTokenSchema.safeParse(token);
    if (!parsed.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid bootstrap authorization"
      });
      return z.NEVER;
    }
    return parsed.data;
  });

export const PasskeyBootstrapAuthorizationSchema = z.object({
  scheme: z.literal(PASSKEY_BOOTSTRAP_AUTHORIZATION_SCHEME),
  token: PasskeyBootstrapTokenSchema,
  purpose: PasskeyBootstrapPurposeSchema,
  expiresAt: TimestampSchema
}).strict();

export const PasskeySignupCeremonyPublicSchema = z.object({
  ...PasskeyCeremonyPublicBaseShape,
  kind: z.literal("registration"),
  purpose: z.literal("account.create")
}).strict();

export const PasskeyLoginCeremonyPublicSchema = z.object({
  ...PasskeyCeremonyPublicBaseShape,
  kind: z.literal("authentication"),
  purpose: z.literal("session.create")
}).strict();

const PasskeyBootstrapRelyingPartySchema = z.object({
  id: z.literal("auth.luxora.app"),
  name: z.literal("Luxora")
}).strict();

const PasskeyBootstrapUserSchema = z.object({
  id: PasskeyUserHandleSchema,
  name: UsernameSchema.transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH)
}).strict();

const PasskeyBootstrapPublicKeyParametersSchema = z.tuple([
  z.object({ type: z.literal("public-key"), alg: z.literal(-7) }).strict(),
  z.object({ type: z.literal("public-key"), alg: z.literal(-257) }).strict()
]);

const PasskeyBootstrapAuthenticatorSelectionSchema = z.object({
  residentKey: z.literal("required"),
  requireResidentKey: z.literal(true),
  userVerification: z.literal("required")
}).strict();

export const PasskeySignupOptionsSchema = z.object({
  challenge: PasskeyChallengeSchema,
  rp: PasskeyBootstrapRelyingPartySchema,
  user: PasskeyBootstrapUserSchema,
  pubKeyCredParams: PasskeyBootstrapPublicKeyParametersSchema,
  // A pre-account ceremony has no authorized account credential set to reveal.
  excludeCredentials: z.tuple([]),
  timeout: z.number().int().positive().max(PASSKEY_MAX_TIMEOUT_MS),
  attestation: z.literal("none"),
  authenticatorSelection: PasskeyBootstrapAuthenticatorSelectionSchema
}).strict();

export const PasskeyPrimaryLoginOptionsSchema = z.object({
  challenge: PasskeyChallengeSchema,
  rpId: z.literal("auth.luxora.app"),
  timeout: z.number().int().positive().max(PASSKEY_MAX_TIMEOUT_MS),
  userVerification: z.literal("required")
  // allowCredentials is intentionally absent. Strict parsing rejects even an
  // empty list so an unauthenticated identifier probe cannot gain a per-user
  // response variant.
}).strict();

const PasskeyBootstrapBeginResponseBaseShape = {
  schemaVersion: z.literal(PASSKEY_HTTP_CONTRACT_VERSION),
  replayed: z.boolean(),
  bootstrapAuthorization: PasskeyBootstrapAuthorizationSchema
};

export const PasskeySignupBeginResponseSchema = z.object({
  ...PasskeyBootstrapBeginResponseBaseShape,
  ceremony: PasskeySignupCeremonyPublicSchema.extend({ state: z.literal("pending") }).strict(),
  bootstrapAuthorization: PasskeyBootstrapAuthorizationSchema.extend({
    purpose: z.literal("account.create")
  }).strict(),
  options: PasskeySignupOptionsSchema
}).strict();

export const PasskeyLoginBeginResponseSchema = z.object({
  ...PasskeyBootstrapBeginResponseBaseShape,
  ceremony: PasskeyLoginCeremonyPublicSchema.extend({ state: z.literal("pending") }).strict(),
  bootstrapAuthorization: PasskeyBootstrapAuthorizationSchema.extend({
    purpose: z.literal("session.create")
  }).strict(),
  options: PasskeyPrimaryLoginOptionsSchema
}).strict();

// Both fixed verify endpoints retain the current exact raw-body contract and
// 65,536-byte transport gate. Ceremony/token/revision/idempotency values are
// headers, never decorator fields injected into the signed WebAuthn payload.
export const VerifyPasskeySignupRequestSchema = PasskeyRegistrationCredentialJSONSchema;
export const VerifyPasskeyLoginRequestSchema = PasskeyAuthenticationCredentialJSONSchema;

const PasskeyBootstrapVerifyResponseBaseShape = {
  schemaVersion: z.literal(PASSKEY_HTTP_CONTRACT_VERSION),
  verified: z.literal(true),
  replayed: z.boolean(),
  user: UserSchema.strict(),
  tokens: AuthTokensSchema.strict()
};

export const PasskeySignupVerifyResponseSchema = z.object({
  ...PasskeyBootstrapVerifyResponseBaseShape,
  ceremony: PasskeySignupCeremonyPublicSchema.extend({ state: z.literal("consumed") }).strict()
}).strict();

export const PasskeyLoginVerifyResponseSchema = z.object({
  ...PasskeyBootstrapVerifyResponseBaseShape,
  ceremony: PasskeyLoginCeremonyPublicSchema.extend({ state: z.literal("consumed") }).strict()
}).strict();

export const PasskeyBootstrapVerifyResponseSchema = z.union([
  PasskeySignupVerifyResponseSchema,
  PasskeyLoginVerifyResponseSchema
]);

export const PASSKEY_PRIMARY_AUTHENTICATION_REJECTION_MESSAGE =
  "Passkey authentication failed" as const;

// Unknown credential, user-handle mismatch, missing account, invalid
// signature, and rejected verifier output all use this exact public shape.
// No reason/details field exists, so callers cannot branch on account state.
export const PasskeyPrimaryAuthenticationRejectionSchema = z.object({
  error: z.object({
    code: z.literal("UNAUTHENTICATED"),
    message: z.literal(PASSKEY_PRIMARY_AUTHENTICATION_REJECTION_MESSAGE),
    requestId: z.string().min(1).max(256)
  }).strict()
}).strict();

export const ChatKindSchema = z.enum(["direct", "group", "channel"]);
export const ChatRoleSchema = z.enum(["owner", "admin", "member"]);

const ImageThumbnailSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  width: z.number().int().positive().max(32_768),
  height: z.number().int().positive().max(32_768)
}).strict();

const ImageMetadataSchema = z.object({
  width: z.number().int().positive().max(32_768).optional(),
  height: z.number().int().positive().max(32_768).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  thumbnail: ImageThumbnailSchema.optional()
}).strict();

const TimedMediaMetadataSchema = z.object({
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  width: z.number().int().positive().max(32_768).optional(),
  height: z.number().int().positive().max(32_768).optional()
}).strict();

const AudioMetadataSchema = z.object({
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  waveform: z.array(z.number().int().min(0).max(255)).max(256).optional()
}).strict();

const AttachmentBaseSchema = z.object({
  id: IdSchema,
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadPath: z.string().startsWith("/v1/attachments/"),
  thumbnailPath: z.string().startsWith("/v1/attachments/").endsWith("/thumbnail").optional(),
  safetyStatus: z.enum(["unscanned", "reencoded"]),
  metadataTrust: z.enum(["client_declared", "server_verified"]),
  createdAt: TimestampSchema
});

export const AttachmentSchema = z.discriminatedUnion("kind", [
  AttachmentBaseSchema.extend({ kind: z.literal("image"), metadata: ImageMetadataSchema }),
  AttachmentBaseSchema.extend({ kind: z.literal("video"), metadata: TimedMediaMetadataSchema }),
  AttachmentBaseSchema.extend({ kind: z.literal("video_message"), metadata: TimedMediaMetadataSchema }),
  AttachmentBaseSchema.extend({ kind: z.literal("audio"), metadata: AudioMetadataSchema }),
  AttachmentBaseSchema.extend({ kind: z.literal("voice"), metadata: AudioMetadataSchema }),
  AttachmentBaseSchema.extend({ kind: z.literal("file"), metadata: z.object({}).strict() })
]);

export const ForwardProvenanceSchema = z.object({
  senderDisplayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  originalCreatedAt: TimestampSchema
});

export const MessageSchema = z.object({
  id: IdSchema,
  chatId: IdSchema,
  sender: UserSchema,
  kind: z.enum(["text", "media"]),
  body: z.string().nullable(),
  replyToMessageId: IdSchema.nullable(),
  topicId: IdSchema.nullable(),
  forwardedFrom: ForwardProvenanceSchema.nullable(),
  attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE),
  transcriptionAllowed: z.boolean(),
  transcript: z.string().nullable(),
  isPinned: z.boolean(),
  clientNonce: IdSchema,
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  editedAt: TimestampSchema.nullable(),
  deletedAt: TimestampSchema.nullable()
});

export const MessageVersionSchema = z.object({
  id: IdSchema,
  messageId: IdSchema,
  revision: z.number().int().nonnegative(),
  body: z.string().nullable(),
  editor: UserSchema,
  createdAt: TimestampSchema
});

export const MessagePinSchema = z.object({
  chatId: IdSchema,
  messageId: IdSchema,
  pinnedBy: UserSchema,
  pinnedAt: TimestampSchema
});

export const TopicSchema = z.object({
  id: IdSchema,
  chatId: IdSchema,
  title: z.string(),
  createdBy: UserSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  closedAt: TimestampSchema.nullable()
});

export const ChatSchema = z.object({
  id: IdSchema,
  kind: ChatKindSchema,
  title: z.string(),
  avatarUrl: z.string().url().nullable(),
  role: ChatRoleSchema,
  memberCount: z.number().int().nonnegative(),
  lastMessage: MessageSchema.nullable(),
  lastActivityAt: TimestampSchema,
  createdAt: TimestampSchema,
  unreadCount: z.number().int().nonnegative(),
  archivedAt: TimestampSchema.nullable(),
  mutedUntil: TimestampSchema.nullable()
});

export const ChatPreferencesSchema = z.object({
  archivedAt: TimestampSchema.nullable(),
  mutedUntil: TimestampSchema.nullable()
}).strict();

export const PatchChatPreferencesSchema = z.object({
  archived: z.boolean().optional(),
  mutedUntil: TimestampSchema.nullable().optional()
}).strict().refine(
  (value) => value.archived !== undefined || value.mutedUntil !== undefined,
  { message: "At least one chat preference must be changed" }
);

const DraftRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ActiveDraftRevisionSchema = DraftRevisionSchema.refine(
  (revision) => revision > 0,
  "An active draft revision must be positive"
);

const LoneSurrogatePattern = /[\uD800-\uDFFF]/u;

export const DraftTextSchema = z.string()
  .refine((text) => !LoneSurrogatePattern.test(text), "Draft text must be well-formed Unicode")
  .refine(
    (text) => [...text].length <= MAX_DRAFT_LENGTH,
    `Draft text must contain at most ${MAX_DRAFT_LENGTH} Unicode code points`
  );

export const ChatDraftSchema = z.object({
  chatId: IdSchema,
  text: DraftTextSchema,
  replyToMessageId: IdSchema.nullable(),
  revision: ActiveDraftRevisionSchema,
  updatedAt: TimestampSchema
}).strict().refine(
  (draft) => draft.text.length > 0 || draft.replyToMessageId !== null,
  { message: "A draft must contain text or a reply target" }
);

export const PutChatDraftRequestSchema = z.object({
  text: DraftTextSchema,
  replyToMessageId: IdSchema.nullable().default(null),
  expectedRevision: DraftRevisionSchema,
  clientNonce: IdSchema
}).strict().refine(
  (draft) => draft.text.length > 0 || draft.replyToMessageId !== null,
  { message: "A draft must contain text or a reply target" }
);

export const DeleteChatDraftRequestSchema = z.object({
  expectedRevision: ActiveDraftRevisionSchema,
  clientNonce: IdSchema
}).strict();

const ChatDraftStateShape = {
  draft: ChatDraftSchema.nullable(),
  revision: DraftRevisionSchema
};

function validateDraftStateRevision(
  state: { draft: z.infer<typeof ChatDraftSchema> | null; revision: number },
  context: z.RefinementCtx
): void {
  if (state.draft !== null && state.draft.revision !== state.revision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Draft and state revisions must match",
      path: ["revision"]
    });
  }
}

export const ChatDraftStateResponseSchema = z.object(ChatDraftStateShape)
  .strict()
  .superRefine(validateDraftStateRevision);

export const ChatDraftMutationResponseSchema = z.object({
  ...ChatDraftStateShape,
  replayed: z.boolean()
}).strict().superRefine(validateDraftStateRevision);

const ChatFolderRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ChatFolderStateRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ChatFolderPositionSchema = z.number().int().nonnegative().max(9_999);

export const ChatFolderTitleSchema = z.string().trim().min(1).refine(
  (title) => [...title].length <= MAX_CHAT_FOLDER_TITLE_LENGTH,
  `Chat folder title must contain at most ${MAX_CHAT_FOLDER_TITLE_LENGTH} Unicode code points`
);

export const ChatFolderRulesSchema = z.object({
  includeKinds: z.array(ChatKindSchema).max(3).refine(
    (kinds) => new Set(kinds).size === kinds.length,
    "Chat folder kinds must be unique"
  ),
  unreadOnly: z.boolean(),
  excludeMuted: z.boolean(),
  includeArchived: z.boolean()
}).strict();

export const ChatFolderOverrideModeSchema = z.enum(["include", "exclude"]);

export const ChatFolderOverrideSchema = z.object({
  chatId: IdSchema,
  mode: ChatFolderOverrideModeSchema,
  pinnedPosition: z.number().int().min(0).max(99).nullable()
}).strict().superRefine((override, context) => {
  if (override.mode !== "include" && override.pinnedPosition !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only included chats can have a pinned position",
      path: ["pinnedPosition"]
    });
  }
});

export const ChatFolderOverridesSchema = z.array(ChatFolderOverrideSchema)
  .max(MAX_CHAT_FOLDER_OVERRIDES)
  .superRefine((overrides, context) => {
    const chatIds = new Set<string>();
    const pinnedPositions = new Set<number>();

    overrides.forEach((override, index) => {
      if (chatIds.has(override.chatId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A chat can appear only once in a folder override list",
          path: [index, "chatId"]
        });
      }
      chatIds.add(override.chatId);

      if (override.pinnedPosition === null) {
        return;
      }
      if (pinnedPositions.has(override.pinnedPosition)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pinned positions must be unique within a folder",
          path: [index, "pinnedPosition"]
        });
      }
      pinnedPositions.add(override.pinnedPosition);
    });
  });

export const ChatFolderSchema = z.object({
  id: IdSchema,
  title: ChatFolderTitleSchema,
  position: ChatFolderPositionSchema,
  revision: ChatFolderRevisionSchema,
  rules: ChatFolderRulesSchema,
  overrides: ChatFolderOverridesSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
}).strict().superRefine((folder, context) => {
  if (Date.parse(folder.updatedAt) < Date.parse(folder.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Chat folder update cannot precede creation time",
      path: ["updatedAt"]
    });
  }
});

export const CreateChatFolderRequestSchema = z.object({
  title: ChatFolderTitleSchema,
  rules: ChatFolderRulesSchema,
  overrides: ChatFolderOverridesSchema,
  clientNonce: IdSchema
}).strict();

export const PatchChatFolderRequestSchema = z.object({
  title: ChatFolderTitleSchema.optional(),
  rules: ChatFolderRulesSchema.optional(),
  overrides: ChatFolderOverridesSchema.optional(),
  expectedRevision: ChatFolderRevisionSchema,
  clientNonce: IdSchema
}).strict().refine(
  (request) => request.title !== undefined
    || request.rules !== undefined
    || request.overrides !== undefined,
  { message: "At least one chat folder field must be changed" }
);

export const DeleteChatFolderRequestSchema = z.object({
  expectedRevision: ChatFolderRevisionSchema,
  clientNonce: IdSchema
}).strict();

export const ReorderChatFoldersRequestSchema = z.object({
  folderIds: z.array(IdSchema).min(1).max(MAX_CHAT_FOLDERS).refine(
    (folderIds) => new Set(folderIds).size === folderIds.length,
    "Chat folder ids must be unique"
  ),
  expectedStateRevision: ChatFolderStateRevisionSchema,
  clientNonce: IdSchema
}).strict();

const ChatFolderCollectionSchema = z.array(ChatFolderSchema)
  .max(MAX_CHAT_FOLDERS)
  .superRefine((folders, context) => {
    const folderIds = new Set<string>();
    const positions = new Set<number>();

    folders.forEach((folder, index) => {
      if (folderIds.has(folder.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Chat folder ids must be unique",
          path: [index, "id"]
        });
      }
      folderIds.add(folder.id);

      if (positions.has(folder.position)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Chat folder positions must be unique",
          path: [index, "position"]
        });
      }
      positions.add(folder.position);
    });
  });

export const ChatFolderListResponseSchema = z.object({
  items: ChatFolderCollectionSchema,
  stateRevision: ChatFolderStateRevisionSchema
}).strict();

export const ChatFolderMutationResponseSchema = z.object({
  folder: ChatFolderSchema,
  stateRevision: ChatFolderStateRevisionSchema,
  replayed: z.boolean()
}).strict();

export const ChatFolderDeleteResponseSchema = z.object({
  folderId: IdSchema,
  stateRevision: ChatFolderStateRevisionSchema,
  replayed: z.boolean()
}).strict();

export const ChatFolderReorderResponseSchema = z.object({
  items: ChatFolderCollectionSchema,
  stateRevision: ChatFolderStateRevisionSchema,
  replayed: z.boolean()
}).strict();

export const ChatMembershipMutableRoleSchema = z.enum(["admin", "member"]);
export const ChatMembershipSchema = z.object({
  chatId: IdSchema,
  userId: IdSchema,
  role: ChatRoleSchema,
  revision: z.number().int().positive(),
  joinedAt: TimestampSchema,
  updatedAt: TimestampSchema
}).strict().superRefine((value, context) => {
  if (Date.parse(value.updatedAt) < Date.parse(value.joinedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Membership update cannot precede join time",
      path: ["updatedAt"]
    });
  }
});
export const ChatMemberSchema = z.object({
  membership: ChatMembershipSchema,
  user: UserSchema
}).strict().superRefine((value, context) => {
  if (value.membership.userId !== value.user.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Membership user does not match profile",
      path: ["user"]
    });
  }
});
export const ChatMemberListResponseSchema = z.object({
  items: z.array(ChatMemberSchema).max(200)
}).strict();
export const AddChatMemberRequestSchema = z.object({
  userId: IdSchema,
  role: ChatMembershipMutableRoleSchema.default("member"),
  clientNonce: IdSchema
}).strict();
export const UpdateChatMemberRoleRequestSchema = z.object({
  role: ChatMembershipMutableRoleSchema,
  expectedRevision: z.number().int().positive(),
  clientNonce: IdSchema
}).strict();
export const RemoveChatMemberRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  clientNonce: IdSchema
}).strict();
export const ChatMembershipMutationResponseSchema = z.object({
  membership: ChatMembershipSchema,
  replayed: z.boolean()
}).strict();

export const ChatInviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ChatInviteLinkSchema = z.object({
  id: IdSchema,
  chatId: IdSchema,
  createdBy: IdSchema,
  approvalRequired: z.boolean().default(false),
  expiresAt: TimestampSchema.nullable(),
  maxUses: z.number().int().positive().max(10_000).nullable(),
  useCount: z.number().int().nonnegative(),
  revokedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema
}).strict();
export const CreateChatInviteLinkRequestSchema = z.object({
  approvalRequired: z.boolean().optional(),
  expiresInSeconds: z.number().int().positive().max(90 * 24 * 3_600).optional(),
  maxUses: z.number().int().positive().max(10_000).optional(),
  clientNonce: IdSchema
}).strict();
export const CreateChatInviteLinkResponseSchema = z.object({
  invite: ChatInviteLinkSchema,
  // Raw bearer token. Shown exactly once: the server stores only its digest,
  // so a lost response cannot be replayed — create a new link instead.
  token: ChatInviteTokenSchema,
  replayed: z.boolean()
}).strict();
export const ChatInviteLinkListResponseSchema = z.object({
  items: z.array(ChatInviteLinkSchema).max(100)
}).strict();
export const RevokeChatInviteLinkResponseSchema = z.object({
  invite: ChatInviteLinkSchema,
  replayed: z.boolean()
}).strict();
export const JoinChatByInviteRequestSchema = z.object({
  token: ChatInviteTokenSchema,
  clientNonce: IdSchema
}).strict();
export const ChatJoinRequestStateSchema = z.enum(["pending", "approved", "denied"]);
export const ChatJoinRequestSchema = z.object({
  id: IdSchema,
  chatId: IdSchema,
  userId: IdSchema,
  inviteLinkId: IdSchema,
  state: ChatJoinRequestStateSchema,
  decidedBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.state === "pending" && (value.decidedBy !== null || value.decidedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Pending join requests carry no decision",
      path: ["state"]
    });
  }
  if (value.state !== "pending" && (value.decidedBy === null || value.decidedAt === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Decided join requests carry a decider and decision time",
      path: ["state"]
    });
  }
});
export const JoinChatByInviteResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("joined"),
    membership: ChatMembershipSchema,
    replayed: z.boolean()
  }).strict(),
  z.object({
    outcome: z.literal("pending"),
    request: ChatJoinRequestSchema,
    replayed: z.boolean()
  }).strict()
]);
export const RequestChatJoinDecisionSchema = z.object({
  clientNonce: IdSchema
}).strict();
export const ChatJoinRequestListResponseSchema = z.object({
  items: z.array(ChatJoinRequestSchema).max(200)
}).strict();
export const DecideChatJoinRequestResponseSchema = z.object({
  request: ChatJoinRequestSchema,
  membership: ChatMembershipSchema.nullable(),
  replayed: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.request.state === "approved" && value.membership === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Approvals carry the created membership",
      path: ["membership"]
    });
  }
  if (value.request.state !== "approved" && value.membership !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only approvals carry a membership",
      path: ["membership"]
    });
  }
});
export const ChatJoinRequestRealtimeEventSchema = z.object({
  type: z.literal("chat.join.request.changed"),
  audience: z.literal("member_account"),
  request: ChatJoinRequestSchema,
  changedAt: TimestampSchema
}).strict();

export const ChatOwnershipTransferStateSchema = z.enum(["pending", "accepted", "cancelled", "expired"]);
export const ChatOwnershipTransferSchema = z.object({
  id: IdSchema,
  chatId: IdSchema,
  fromUserId: IdSchema,
  toUserId: IdSchema,
  state: ChatOwnershipTransferStateSchema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  decidedBy: IdSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.fromUserId === value.toUserId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ownership cannot transfer to the current owner",
      path: ["toUserId"]
    });
  }
  if (value.state === "pending" && (value.decidedAt !== null || value.decidedBy !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Pending transfers carry no decision",
      path: ["state"]
    });
  }
  if (value.state !== "pending" && (value.decidedAt === null || value.decidedBy === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Decided transfers carry a decider and decision time",
      path: ["state"]
    });
  }
});
export const InitiateOwnershipTransferRequestSchema = z.object({
  targetUserId: IdSchema,
  clientNonce: IdSchema
}).strict();
export const ChatOwnershipTransferResponseSchema = z.object({
  transfer: ChatOwnershipTransferSchema,
  replayed: z.boolean()
}).strict();
export const ChatOwnershipTransferChangedRealtimeEventSchema = z.object({
  type: z.literal("chat.ownership.transfer.changed"),
  audience: z.literal("member_account"),
  transfer: ChatOwnershipTransferSchema,
  changedAt: TimestampSchema
}).strict();
export const CreateChatRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("direct"),
    userId: IdSchema
  }).strict(),
  z.object({
    kind: z.literal("group"),
    title: z.string().trim().min(1).max(MAX_CHAT_TITLE_LENGTH),
    memberIds: z.array(IdSchema).max(199).default([])
  }).strict(),
  z.object({
    kind: z.literal("channel"),
    title: z.string().trim().min(1).max(MAX_CHAT_TITLE_LENGTH),
    memberIds: z.array(IdSchema).max(199).default([])
  }).strict()
]);

const MessageBodySchema = z.string().trim().min(1).refine(
    (body) => [...body].length <= MAX_MESSAGE_LENGTH,
    `Message must contain at most ${MAX_MESSAGE_LENGTH} Unicode code points`
  );

export const SendMessageRequestSchema = z.object({
  kind: z.literal("text").optional(),
  body: MessageBodySchema.nullable().default(null),
  clientNonce: IdSchema,
  replyToMessageId: IdSchema.nullable().default(null),
  topicId: IdSchema.nullable().default(null),
  attachmentIds: z.array(IdSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  transcriptionConsent: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  if (value.body === null && value.attachmentIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A message must contain text or at least one attachment"
    });
  }
  if (value.transcriptionConsent && value.attachmentIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Transcription consent requires at least one attachment"
    });
  }
});

export const MAX_TRANSCRIPT_LENGTH = 2_000;

export const TranscriptTextSchema = z.string().trim().min(1).superRefine((text, context) => {
  if ([...text].length > MAX_TRANSCRIPT_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Transcript must contain at most ${MAX_TRANSCRIPT_LENGTH} Unicode code points`
    });
  }
});

export const PutMessageTranscriptSchema = z.object({
  text: TranscriptTextSchema,
  clientNonce: IdSchema
}).strict();

export const SCHEDULED_SEND_MIN_LEAD_SECONDS = 60;
export const SCHEDULED_SEND_MAX_HORIZON_DAYS = 365;

export const ScheduleMessageRequestSchema = z.object({
  body: MessageBodySchema,
  clientNonce: IdSchema,
  replyToMessageId: IdSchema.nullable().default(null),
  topicId: IdSchema.nullable().default(null),
  attachmentIds: z.array(IdSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  sendAt: TimestampSchema
}).strict();

export const ScheduledMessageSchema = z.object({
  id: IdSchema,
  chatId: IdSchema,
  body: z.string(),
  replyToMessageId: IdSchema.nullable(),
  topicId: IdSchema.nullable(),
  sendAt: TimestampSchema,
  state: z.enum(["pending", "sent", "cancelled", "failed"]),
  failureCode: z.string().nullable(),
  createdAt: TimestampSchema
}).strict();

export const ScheduledMessageListResponseSchema = z.object({
  items: z.array(ScheduledMessageSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();

export const EditMessageRequestSchema = z.object({
  body: MessageBodySchema.nullable(),
  expectedRevision: z.number().int().nonnegative().optional()
}).strict();

export const ForwardMessageRequestSchema = z.object({
  chatId: IdSchema,
  clientNonce: IdSchema,
  topicId: IdSchema.nullable().default(null)
}).strict();

const UploadBaseSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().toLowerCase().min(3).max(127),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: IdSchema
});

export const CreateUploadRequestSchema = z.discriminatedUnion("kind", [
  UploadBaseSchema.extend({ kind: z.literal("image"), metadata: ImageMetadataSchema.default({}) }).strict(),
  UploadBaseSchema.extend({ kind: z.literal("video"), metadata: TimedMediaMetadataSchema.default({}) }).strict(),
  UploadBaseSchema.extend({ kind: z.literal("video_message"), metadata: TimedMediaMetadataSchema.default({}) }).strict(),
  UploadBaseSchema.extend({ kind: z.literal("audio"), metadata: AudioMetadataSchema.default({}) }).strict(),
  UploadBaseSchema.extend({ kind: z.literal("voice"), metadata: AudioMetadataSchema.default({}) }).strict(),
  UploadBaseSchema.extend({ kind: z.literal("file"), metadata: z.object({}).strict().default({}) }).strict()
]);

export const UploadSessionSchema = z.object({
  id: IdSchema,
  status: z.enum(["active", "completing", "completed", "failed", "expired"]),
  fileName: z.string(),
  sizeBytes: z.number().int().positive(),
  chunkSizeBytes: z.number().int().positive(),
  receivedBytes: z.number().int().nonnegative(),
  receivedChunkIndexes: z.array(z.number().int().nonnegative()),
  expiresAt: TimestampSchema,
  attachment: AttachmentSchema.nullable(),
  failureCode: z.string().nullable()
});

export const CreateTopicRequestSchema = z.object({
  title: z.string().trim().min(1).max(120)
}).strict();

export const UpdateTopicRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  closed: z.boolean().optional()
}).strict().refine((value) => value.title !== undefined || value.closed !== undefined, {
  message: "At least one topic field must be changed"
});

export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE)
});

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CapabilitiesRuntimeLimitShape = {
  maxAttachmentBytes: PositiveSafeIntegerSchema,
  userStorageQuotaBytes: PositiveSafeIntegerSchema,
  uploadChunkSizeBytes: PositiveSafeIntegerSchema,
  uploadSessionTtlSeconds: PositiveSafeIntegerSchema
};

export const CapabilitiesRuntimeStateSchema = z.object({
  ...CapabilitiesRuntimeLimitShape,
  serverSearchConfigured: z.boolean(),
  phoneAuthenticationAvailable: z.boolean()
})
  .strict()
  .refine((state) => state.userStorageQuotaBytes >= state.maxAttachmentBytes, {
    message: "User storage quota must be at least the per-attachment limit",
    path: ["userStorageQuotaBytes"]
  });

// Capability responses are an additive read contract: unknown response fields
// are intentionally stripped by Zod's default object behavior. Mutation/input
// schemas remain strict and reject unknown fields.
export const CapabilitiesResponseV1Schema = z.object({
  schemaVersion: z.literal(CAPABILITIES_SCHEMA_VERSION),
  versions: z.object({
    http: z.tuple([z.literal(HTTP_API_VERSION)]),
    reconciliation: z.tuple([z.literal(RECONCILIATION_API_VERSION)]),
    realtime: z.object({
      supported: z.tuple([
        z.literal(PROTOCOL_VERSION),
        z.literal(IA1_PROTOCOL_VERSION)
      ]),
      preferred: z.literal(REALTIME_PREFERRED_PROTOCOL_VERSION),
      minimum: z.literal(REALTIME_MINIMUM_PROTOCOL_VERSION)
    })
  }),
  identityContractVersion: z.literal(IDENTITY_ACCESS_CONTRACT_VERSION),
  trust: z.object({
    profile: z.literal("cloud_preview"),
    contentReadableByServer: z.literal(true),
    endToEndEncryption: z.literal(false)
  }),
  features: z.object({
    passwordAuthentication: z.literal(true),
    phoneAuthentication: z.boolean(),
    deviceSessions: z.literal(true),
    messaging: z.literal(true),
    identityAccess: z.literal(true),
    safetyReports: z.literal(true),
    realtime: z.literal(true),
    reconciliation: z.literal(true),
    // Older Beta-0.1 servers predate this additive field. A new client must
    // conservatively assume the projection invalidation signal is unavailable
    // instead of rejecting an otherwise compatible response.
    syncInvalidation: z.boolean().default(false),
    chatFolders: z.literal(true),
    // Old Beta-0.1 servers omit this additive field. Clients must keep local
    // drafts device-only unless the server explicitly advertises support.
    drafts: z.boolean().default(false),
    mediaUploads: z.literal(true),
    serverSearchConfigured: z.boolean(),
    calls: z.literal(false),
    passkeys: z.literal(false),
    push: z.literal(false)
  }),
  limits: z.object({
    maxMessageCodePoints: z.literal(MAX_MESSAGE_LENGTH),
    maxDraftCodePoints: z.literal(MAX_DRAFT_LENGTH).default(MAX_DRAFT_LENGTH),
    chatDraftIdempotencyTtlSeconds: z.literal(CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS)
      .default(CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS),
    maxChatDraftActiveCommandReceipts: z.literal(MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS)
      .default(MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS),
    maxMessageRequestCodePoints: z.literal(MAX_MESSAGE_REQUEST_LENGTH),
    maxChatTitleLength: z.literal(MAX_CHAT_TITLE_LENGTH),
    maxChatFolders: z.literal(MAX_CHAT_FOLDERS),
    maxChatFolderTitleLength: z.literal(MAX_CHAT_FOLDER_TITLE_LENGTH),
    maxChatFolderOverrides: z.literal(MAX_CHAT_FOLDER_OVERRIDES),
    chatFolderIdempotencyTtlSeconds: z.literal(CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS),
    maxChatFolderActiveCommandReceipts: z.literal(MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS),
    maxAttachmentsPerMessage: z.literal(MAX_ATTACHMENTS_PER_MESSAGE),
    maxDisplayNameLength: z.literal(MAX_DISPLAY_NAME_LENGTH),
    maxSafetyReportCommentCodePoints: z.literal(MAX_SAFETY_REPORT_COMMENT_LENGTH),
    maxSafetyReportEvidence: z.literal(MAX_SAFETY_REPORT_EVIDENCE),
    defaultPageItems: z.literal(DEFAULT_PAGE_SIZE),
    maxPageItems: z.literal(MAX_PAGE_SIZE),
    realtimeMaxReplayEvents: z.literal(REALTIME_MAX_REPLAY_EVENTS),
    realtimeCursorTtlSeconds: z.literal(REALTIME_CURSOR_TTL_SECONDS),
    ...CapabilitiesRuntimeLimitShape
  }),
  compatibility: z.object({
    additiveResponseFields: z.literal("ignore"),
    unknownMutationFields: z.literal("reject"),
    securityCriticalIncompatibility: z.literal("required_upgrade"),
    realtimeBelowMinimum: z.literal("no_downgrade")
  })
});

export type CapabilitiesRuntimeState = z.infer<typeof CapabilitiesRuntimeStateSchema>;
export type CapabilitiesResponseV1 = z.infer<typeof CapabilitiesResponseV1Schema>;

export function createCapabilitiesResponseV1(
  runtimeState: CapabilitiesRuntimeState,
  syncInvalidationAvailable = true
): CapabilitiesResponseV1 {
  const state = CapabilitiesRuntimeStateSchema.parse(runtimeState);
  const {
    serverSearchConfigured,
    phoneAuthenticationAvailable,
    ...limits
  } = state;
  return CapabilitiesResponseV1Schema.parse({
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    versions: {
      http: [HTTP_API_VERSION],
      reconciliation: [RECONCILIATION_API_VERSION],
      realtime: {
        supported: [PROTOCOL_VERSION, IA1_PROTOCOL_VERSION],
        preferred: REALTIME_PREFERRED_PROTOCOL_VERSION,
        minimum: REALTIME_MINIMUM_PROTOCOL_VERSION
      }
    },
    identityContractVersion: IDENTITY_ACCESS_CONTRACT_VERSION,
    trust: {
      profile: "cloud_preview",
      contentReadableByServer: true,
      endToEndEncryption: false
    },
    features: {
      passwordAuthentication: true,
      phoneAuthentication: phoneAuthenticationAvailable,
      deviceSessions: true,
      messaging: true,
      identityAccess: true,
      safetyReports: true,
      realtime: true,
      reconciliation: true,
      syncInvalidation: syncInvalidationAvailable,
      chatFolders: true,
      drafts: true,
      mediaUploads: true,
      serverSearchConfigured,
      calls: false,
      passkeys: false,
      push: false
    },
    limits: {
      maxMessageCodePoints: MAX_MESSAGE_LENGTH,
      maxDraftCodePoints: MAX_DRAFT_LENGTH,
      chatDraftIdempotencyTtlSeconds: CHAT_DRAFT_IDEMPOTENCY_TTL_SECONDS,
      maxChatDraftActiveCommandReceipts: MAX_CHAT_DRAFT_ACTIVE_COMMAND_RECEIPTS,
      maxMessageRequestCodePoints: MAX_MESSAGE_REQUEST_LENGTH,
      maxChatTitleLength: MAX_CHAT_TITLE_LENGTH,
      maxChatFolders: MAX_CHAT_FOLDERS,
      maxChatFolderTitleLength: MAX_CHAT_FOLDER_TITLE_LENGTH,
      maxChatFolderOverrides: MAX_CHAT_FOLDER_OVERRIDES,
      chatFolderIdempotencyTtlSeconds: CHAT_FOLDER_IDEMPOTENCY_TTL_SECONDS,
      maxChatFolderActiveCommandReceipts: MAX_CHAT_FOLDER_ACTIVE_COMMAND_RECEIPTS,
      maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
      maxDisplayNameLength: MAX_DISPLAY_NAME_LENGTH,
      maxSafetyReportCommentCodePoints: MAX_SAFETY_REPORT_COMMENT_LENGTH,
      maxSafetyReportEvidence: MAX_SAFETY_REPORT_EVIDENCE,
      defaultPageItems: DEFAULT_PAGE_SIZE,
      maxPageItems: MAX_PAGE_SIZE,
      realtimeMaxReplayEvents: REALTIME_MAX_REPLAY_EVENTS,
      realtimeCursorTtlSeconds: REALTIME_CURSOR_TTL_SECONDS,
      ...limits
    },
    compatibility: {
      additiveResponseFields: "ignore",
      unknownMutationFields: "reject",
      securityCriticalIncompatibility: "required_upgrade",
      realtimeBelowMinimum: "no_downgrade"
    }
  });
}

export const RealtimeVersionPolicySchema = z.object({
  supported: z.array(PositiveSafeIntegerSchema).min(1).max(16),
  preferred: PositiveSafeIntegerSchema,
  minimum: PositiveSafeIntegerSchema
}).strict().superRefine((policy, context) => {
  if (new Set(policy.supported).size !== policy.supported.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Supported realtime versions must be unique",
      path: ["supported"]
    });
  }
  if (!policy.supported.includes(policy.preferred)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Preferred realtime version must be supported",
      path: ["preferred"]
    });
  }
  if (!policy.supported.includes(policy.minimum)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Minimum realtime version must be supported",
      path: ["minimum"]
    });
  }
  if (policy.supported.some((version) => version < policy.minimum)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Supported realtime versions cannot be below the security minimum",
      path: ["supported"]
    });
  }
});

const ClientRealtimeVersionsSchema = z.array(PositiveSafeIntegerSchema)
  .min(1)
  .max(16)
  .refine((versions) => new Set(versions).size === versions.length, {
    message: "Client realtime versions must be unique"
  });

export const RealtimeCompatibilityDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("compatible"),
    realtimeVersion: PositiveSafeIntegerSchema
  }).strict(),
  z.object({
    status: z.literal("required_upgrade"),
    reason: z.literal("security_minimum_not_supported"),
    minimumRealtimeVersion: PositiveSafeIntegerSchema,
    downgradeAllowed: z.literal(false)
  }).strict(),
  z.object({
    status: z.literal("incompatible"),
    reason: z.literal("no_common_realtime_version"),
    downgradeAllowed: z.literal(false)
  }).strict()
]);

export type RealtimeVersionPolicy = z.infer<typeof RealtimeVersionPolicySchema>;
export type RealtimeCompatibilityDecision = z.infer<typeof RealtimeCompatibilityDecisionSchema>;

export function negotiateRealtimeVersion(
  policy: RealtimeVersionPolicy,
  clientSupportedVersions: readonly number[]
): RealtimeCompatibilityDecision {
  const server = RealtimeVersionPolicySchema.parse(policy);
  const client = ClientRealtimeVersionsSchema.parse([...clientSupportedVersions]);
  const clientVersions = new Set(client);
  const compatible = server.supported.filter((version) => clientVersions.has(version));
  if (compatible.length > 0) {
    const realtimeVersion = compatible.includes(server.preferred)
      ? server.preferred
      : Math.max(...compatible);
    return RealtimeCompatibilityDecisionSchema.parse({ status: "compatible", realtimeVersion });
  }
  if (Math.max(...client) < server.minimum) {
    return RealtimeCompatibilityDecisionSchema.parse({
      status: "required_upgrade",
      reason: "security_minimum_not_supported",
      minimumRealtimeVersion: server.minimum,
      downgradeAllowed: false
    });
  }
  return RealtimeCompatibilityDecisionSchema.parse({
    status: "incompatible",
    reason: "no_common_realtime_version",
    downgradeAllowed: false
  });
}

export const SearchQuerySchema = CursorQuerySchema.extend({
  q: z.string().trim().min(1).max(200),
  chatId: IdSchema.optional()
});

// Account data export: a single authenticated artifact built server-side and
// deleted after a short TTL. The client asks for the export (idempotently
// returning the latest live artifact) and later downloads it with byte-range
// support. No token, password, passkey, raw-IP or other-user restricted data
// is ever included by the builder.
export const DataExportStateSchema = z.enum(["pending", "ready", "expired"]);

export const DataExportRecordSchema = z.object({
  id: IdSchema,
  state: DataExportStateSchema,
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  sizeBytes: z.number().int().nullable()
});

export const CreateDataExportRequestSchema = z.object({}).strict();

export const DataExportRequestResponseSchema = z.object({
  dataExport: DataExportRecordSchema
});

export const DataExportStatusResponseSchema = z.object({
  dataExport: DataExportRecordSchema
});

// Account deletion state machine from IDENTITY_ACCESS §14.2:
// none -> scheduled -> deletion_pending -> executing -> completed | failed_retryable.
// A scheduled deletion is cancellable during its grace window with the original
// scheduling session; after the deadline the account is irrevocably tombstones.
export const AccountDeletionStateSchema = z.enum([
  "none",
  "scheduled",
  "deletion_pending",
  "executing",
  "completed",
  "failed_retryable"
]);

export const AccountDeletionRecordSchema = z.object({
  accountId: IdSchema,
  state: AccountDeletionStateSchema,
  scheduledAt: z.string().nullable(),
  graceDeadlineAt: z.string().nullable(),
  scheduledBySessionId: z.string().nullable(),
  canceledAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  completedAt: z.string().nullable()
});

export const AccountDeletionStatusResponseSchema = z.object({
  deletion: AccountDeletionRecordSchema
});

export const ScheduleAccountDeletionResponseSchema = z.object({
  deletion: AccountDeletionRecordSchema
});

export const CancelAccountDeletionResponseSchema = z.object({
  deletion: AccountDeletionRecordSchema
});

export const ScheduleAccountDeletionRequestSchema = z.object({}).strict();

// Calls signaling first slice (CALLS_PLATFORM §7): lifecycle records only —
// create/get/cancel/hangup for direct chats. No invite/ring/push, no
// join-grants, no webhooks yet. Internal media identifiers (roomName) and
// device/session internals never leave the server in this slice.
export const CallKindSchema = z.enum(["one_to_one", "group", "scheduled"]);
export const CallMediaModeSchema = z.enum(["audio", "video"]);
export const CallStateSchema = z.enum([
  "created",
  "inviting",
  "ringing",
  "connecting",
  "active",
  "reconnecting",
  "ending",
  "ended"
]);
export const CallEndReasonSchema = z.enum([
  "declined",
  "cancelled",
  "no-answer",
  "busy",
  "membership-revoked",
  "kicked",
  "network-timeout",
  "server-failure",
  "completed"
]);
export const CallParticipantRoleSchema = z.enum(["host", "member"]);
export const CallParticipantStatusSchema = z.enum([
  "invited",
  "ringing",
  "accepted",
  "connecting",
  "active",
  "reconnecting",
  "declined",
  "left",
  "kicked",
  "revoked"
]);

export const CallParticipantSchema = z.object({
  membershipId: IdSchema,
  memberId: IdSchema,
  role: CallParticipantRoleSchema,
  status: CallParticipantStatusSchema,
  membershipEpoch: z.number().int().min(1),
  invitedAtMs: z.number().int().nonnegative(),
  acceptedAtMs: z.number().int().nonnegative().nullable(),
  activeAtMs: z.number().int().nonnegative().nullable(),
  removedAtMs: z.number().int().nonnegative().nullable()
});

export const CallResponseSchema = z.object({
  callId: IdSchema,
  chatId: IdSchema,
  kind: CallKindSchema,
  mediaMode: CallMediaModeSchema,
  state: CallStateSchema,
  revision: z.number().int().min(1),
  epoch: z.number().int().min(1),
  creatorMemberId: IdSchema,
  participants: z.array(CallParticipantSchema).max(256),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  pendingEndReason: CallEndReasonSchema.nullable(),
  endReason: CallEndReasonSchema.nullable(),
  endedAtMs: z.number().int().nonnegative().nullable()
});

export const CreateCallRequestSchema = z.object({
  chatId: IdSchema,
  mediaMode: CallMediaModeSchema,
  clientNonce: IdSchema
}).strict();

export const CreateCallResponseSchema = z.object({
  call: CallResponseSchema,
  replayed: z.boolean(),
  unreachableMemberIds: z.array(IdSchema)
});

export const CallStatusResponseSchema = z.object({
  call: CallResponseSchema
});

export const CancelCallRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative()
}).strict();

export const DeclineCallRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.enum(["declined", "busy"])
}).strict();

export const InviteCallParticipantRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  inviteeMemberId: IdSchema
}).strict();

export const CallTrackSourceSchema = z.enum(["microphone", "camera", "screen_share", "screen_share_audio"]);

export const JoinGrantRequestSchema = z.object({
  requestedSources: z.array(CallTrackSourceSchema).max(4)
}).strict();

export const JoinGrantResponseSchema = z.object({
  serverUrl: z.string().min(1).max(256),
  token: z.string().min(1).max(8192),
  tokenExpiresAtMs: z.number().int().nonnegative(),
  participantIdentity: z.string().min(1).max(128),
  turn: z.object({
    urls: z.array(z.string().min(1).max(256)).min(1).max(4),
    username: z.string().min(1).max(512),
    credential: z.string().min(1).max(128),
    expiresAtMs: z.number().int().nonnegative()
  }),
  call: z.object({
    callId: IdSchema,
    revision: z.number().int().min(1),
    epoch: z.number().int().min(1)
  })
});

export const HangupCallRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  scope: z.enum(["self", "everyone"])
}).strict();

// Authenticated QR device linking, first slice (IDENTITY_ACCESS §10):
// challenge lifecycle only (create/poll/close/expire). Approval, grant
// redemption and session issuance arrive in later slices. The link secret is
// a 256-bit server random returned once at creation; the server stores only
// its SHA-256 digest. Polling never reveals account data.
export const DeviceLinkChallengeStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
  "closed"
]);

export const DeviceLinkSecretSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const DeviceLinkProofKeySchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export const CreateDeviceLinkChallengeRequestSchema = z.object({
  targetLabel: z.string().trim().min(1).max(64).optional(),
  proofPublicKey: DeviceLinkProofKeySchema.optional()
}).strict();

export const CreateDeviceLinkChallengeResponseSchema = z.object({
  linkId: IdSchema,
  linkSecret: DeviceLinkSecretSchema,
  expiresAt: TimestampSchema,
  pollIntervalMs: z.number().int().positive()
});

export const DeviceLinkChallengeSchema = z.object({
  linkId: IdSchema,
  state: DeviceLinkChallengeStateSchema,
  expiresAt: TimestampSchema,
  retryAfterMs: z.number().int().nonnegative(),
  sasWords: z.array(z.string().min(1).max(16)).length(4).nullable().default(null)
});

export const DeviceLinkChallengeSecretSchema = z.object({
  linkSecret: DeviceLinkSecretSchema.optional()
}).strict();

export const DeviceLinkRedeemRequestSchema = z.object({
  linkSecret: DeviceLinkSecretSchema.optional(),
  proofSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).optional()
}).strict();

export const DeviceLinkRedeemResponseSchema = z.object({
  tokens: AuthTokensSchema
});

export const DeviceLinkApproveRequestSchema = z.object({
  linkSecret: DeviceLinkSecretSchema.optional(),
  password: z.string().min(1).max(128).optional(),
  stepUpCeremonyId: z.string().min(1).max(128).optional(),
  stepUpToken: z.string().min(1).max(4096).optional()
}).strict().superRefine((value, context) => {
  const hasPassword = value.password !== undefined;
  const hasCeremony = value.stepUpCeremonyId !== undefined || value.stepUpToken !== undefined;
  if (hasPassword === hasCeremony) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "approval requires either password or a step-up ceremony pair, exclusively",
      path: ["password"]
    });
  }
  if (hasCeremony && (value.stepUpCeremonyId === undefined || value.stepUpToken === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ceremony approval requires both stepUpCeremonyId and stepUpToken",
      path: ["stepUpCeremonyId"]
    });
  }
});

export const DeviceLinkChallengeResponseSchema = z.object({
  challenge: DeviceLinkChallengeSchema
});

export const MessageRequestStateSchema = z.enum([
  "pending",
  "accepted",
  "recipient_dismissed",
  "expired"
]);

// A sender must never be told that the recipient previewed or dismissed the
// request. Repositories map recipient_dismissed to pending for this projection.
export const MessageRequestSenderStateSchema = z.enum(["pending", "accepted", "expired"]);

export const MessageRequestFirstTextSchema = z.string().trim().min(1).superRefine((body, context) => {
  if ([...body].length > MAX_MESSAGE_REQUEST_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Message request text must contain at most ${MAX_MESSAGE_REQUEST_LENGTH} Unicode code points`
    });
  }
});

// Operator administration (Beta-0.1 local preview only). These read-only
// projections are for the loopback operator console: they deliberately omit
// password material, digests, ciphertexts, tokens and phone numbers. The
// routes are token-gated and absent without an admin token.
export const AdminUserListItemSchema = z.object({
  id: IdSchema,
  username: UsernameSchema,
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  phoneBound: z.boolean(),
  phonePasswordEnabled: z.boolean(),
  passwordAuthEnabled: z.boolean(),
  activeSessions: z.number().int().nonnegative(),
  chatCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema.nullable()
}).strict();

export const AdminUserListResponseSchema = z.object({
  items: z.array(AdminUserListItemSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();

export const AdminChatListItemSchema = z.object({
  id: IdSchema,
  kind: z.enum(["direct", "group", "channel"]),
  title: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema
}).strict();

export const AdminChatListResponseSchema = z.object({
  items: z.array(AdminChatListItemSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();

export const AdminStatusResponseSchema = z.object({
  migrationId: z.string().min(1).max(64),
  users: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative(),
  chatsByKind: z.object({
    direct: z.number().int().nonnegative(),
    group: z.number().int().nonnegative(),
    channel: z.number().int().nonnegative()
  }).strict(),
  messages: z.number().int().nonnegative(),
  phoneIdentities: z.number().int().nonnegative(),
  pendingOutbox: z.number().int().nonnegative(),
  failedOutbox: z.number().int().nonnegative()
}).strict();

export type AdminUserListItem = z.infer<typeof AdminUserListItemSchema>;
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;
export type AdminChatListItem = z.infer<typeof AdminChatListItemSchema>;
export type AdminChatListResponse = z.infer<typeof AdminChatListResponseSchema>;
export type AdminStatusResponse = z.infer<typeof AdminStatusResponseSchema>;

export const MessageRequestHttpLinkSchema = z.string()
  .max(2_048)
  .url()
  .refine((link) => /^https?:\/\//iu.test(link), "Only HTTP(S) links are allowed");

const MESSAGE_REQUEST_URI_PATTERN = /\b(?:(?:[a-z][a-z0-9+.-]*):\/\/|(?:javascript|data|vbscript|file):)[^\s<>"'`]*/giu;

function messageRequestLinkCandidates(body: string): string[] {
  return (body.match(MESSAGE_REQUEST_URI_PATTERN) ?? []).map((candidate) =>
    candidate.replace(/[.,!?;]+$/u, "")
  );
}

function normalizeValidatedHttpLink(link: string): string {
  const separator = link.indexOf("://");
  return `${link.slice(0, separator).toLowerCase()}${link.slice(separator)}`;
}

const CreateMessageRequestInputSchema = z.object({
  recipientUserId: IdSchema,
  body: MessageRequestFirstTextSchema,
  clientNonce: IdSchema
}).strict();

// validatedLink is derived by the protocol parser and cannot be supplied by a
// client because the input object above is strict. The service remains
// responsible for SSRF-safe preview fetching; this marker only proves the
// bounded text contained at most one syntactically valid HTTP(S) URL.
export const CreateMessageRequestSchema = CreateMessageRequestInputSchema
  .superRefine((value, context) => {
    const candidates = messageRequestLinkCandidates(value.body);
    if (candidates.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "A message request may contain at most one link"
      });
    }

    for (const candidate of candidates) {
      if (!MessageRequestHttpLinkSchema.safeParse(candidate).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message: "Message request links must use a valid HTTP(S) URL"
        });
      }
    }
  })
  .transform((value) => {
    const candidate = messageRequestLinkCandidates(value.body)[0];
    return {
      ...value,
      validatedLink: candidate === undefined ? null : normalizeValidatedHttpLink(candidate)
    };
  });

const MessageRequestCommonShape = {
  id: IdSchema,
  body: MessageRequestFirstTextSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema
};

export const MessageRequestSenderProjectionSchema = z.object({
  ...MessageRequestCommonShape,
  direction: z.literal("outgoing"),
  state: MessageRequestSenderStateSchema,
  recipient: PublicProfileSchema
}).strict();

export const MessageRequestRecipientProjectionSchema = z.object({
  ...MessageRequestCommonShape,
  direction: z.literal("incoming"),
  state: MessageRequestStateSchema,
  sender: PublicProfileSchema
}).strict();

export const MessageRequestProjectionSchema = z.discriminatedUnion("direction", [
  MessageRequestSenderProjectionSchema,
  MessageRequestRecipientProjectionSchema
]);

export const CreateMessageRequestResponseSchema = z.object({
  request: MessageRequestSenderProjectionSchema
}).strict();

export const AcceptedMessageRequestSchema = MessageRequestRecipientProjectionSchema.extend({
  state: z.literal("accepted"),
  acceptedAt: TimestampSchema
}).strict();

export const AcceptMessageRequestResponseSchema = z.object({
  request: AcceptedMessageRequestSchema,
  chat: ChatSchema
}).strict();

export const MessageRequestListResponseSchema = z.object({
  items: z.array(MessageRequestProjectionSchema),
  nextCursor: z.string().nullable()
}).strict();

export const BlockMutationResponseSchema = z.object({
  accountId: IdSchema,
  blocked: z.boolean(),
  changedAt: TimestampSchema
}).strict();

// The profile is an optional snapshot captured at block time. It must not be
// refreshed from the target account after the block is active.
export const BlockedAccountSummarySchema = z.object({
  accountId: IdSchema,
  profileSnapshot: PublicProfileSchema.nullable(),
  blockedAt: TimestampSchema
}).strict().superRefine((value, context) => {
  if (value.profileSnapshot !== null && value.profileSnapshot.id !== value.accountId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["profileSnapshot", "id"],
      message: "Profile snapshot must describe the blocked account"
    });
  }
});

export const BlockListResponseSchema = z.object({
  items: z.array(BlockedAccountSummarySchema),
  nextCursor: z.string().nullable()
}).strict();

export const SafetyReportCategorySchema = z.enum([
  "spam",
  "scam",
  "harassment",
  "hate",
  "sexual_content",
  "violence",
  "impersonation",
  "self_harm",
  "other"
]);

export const SafetyReportEvidenceSchema = z.object({
  type: z.literal("message"),
  messageId: IdSchema
}).strict();

const SafetyReportCommentSchema = z.string().trim().min(1).superRefine((comment, context) => {
  if ([...comment].length > MAX_SAFETY_REPORT_COMMENT_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Report comment must contain at most ${MAX_SAFETY_REPORT_COMMENT_LENGTH} Unicode code points`
    });
  }
});

export const CreateSafetyReportSchema = z.object({
  subjectAccountId: IdSchema,
  category: SafetyReportCategorySchema,
  evidence: z.array(SafetyReportEvidenceSchema).max(MAX_SAFETY_REPORT_EVIDENCE).default([]),
  comment: SafetyReportCommentSchema.nullable().default(null),
  alsoBlock: z.boolean().default(false),
  clientNonce: IdSchema
}).strict().superRefine((value, context) => {
  if (value.evidence.length === 0 && value.category !== "impersonation" && value.category !== "other") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "This report category requires at least one selected message"
    });
  }

  const uniqueMessageIds = new Set(value.evidence.map((item) => item.messageId));
  if (uniqueMessageIds.size !== value.evidence.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Report evidence must not contain duplicate message references"
    });
  }
});

// Responses and realtime deliberately expose only an acknowledgement summary,
// never the reporter's plaintext comment or selected evidence references.
export const SafetyReportSummarySchema = z.object({
  id: IdSchema,
  subjectAccountId: IdSchema,
  category: SafetyReportCategorySchema,
  evidenceCount: z.number().int().min(0).max(MAX_SAFETY_REPORT_EVIDENCE),
  alsoBlocked: z.boolean(),
  status: z.literal("submitted"),
  submittedAt: TimestampSchema
}).strict();

export const CreateSafetyReportResponseSchema = z.object({
  report: SafetyReportSummarySchema
}).strict();

export const SafetyReportListResponseSchema = z.object({
  items: z.array(SafetyReportSummarySchema),
  nextCursor: z.string().nullable()
}).strict();

export const MarkReadRequestSchema = z.object({
  messageId: IdSchema
}).strict();

export const ReactionRequestSchema = z.object({
  emoji: z.string().trim().min(1).max(32)
}).strict();

export const ReactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  reactedByMe: z.boolean()
});

export const MessageReceiptSchema = z.object({
  userId: IdSchema,
  deliveredAt: TimestampSchema,
  readAt: TimestampSchema.nullable()
}).strict();

export const MessageReactionListResponseSchema = z.object({
  items: z.array(ReactionSummarySchema)
}).strict();

export const MessageReceiptListResponseSchema = z.object({
  items: z.array(MessageReceiptSchema)
}).strict();

export const ChatListResponseSchema = z.object({
  items: z.array(ChatSchema),
  nextCursor: z.string().nullable()
});

export const MessageListResponseSchema = z.object({
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable()
});

export const AttachmentListResponseSchema = z.object({
  items: z.array(AttachmentSchema),
  nextCursor: z.string().nullable()
}).strict();

export const UserSearchResponseSchema = z.object({
  items: z.array(UserSchema),
  nextCursor: z.string().nullable()
});

// A v2 realtime cursor is opaque to clients. It is authenticated and bound to
// one account + device session by the API; clients must persist and return it
// verbatim instead of deriving meaning from the global sequence.
export const RealtimeCursorSchema = z.string()
  .min(80)
  .max(512)
  .regex(/^luxora-rt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

export const RealtimeSyncRequiredReasonSchema = z.enum([
  "cursor_invalid",
  "cursor_scope_mismatch",
  "cursor_expired",
  "cursor_ahead",
  "replay_window_exceeded",
  "backpressure"
]);

export const RealtimeSnapshotResponseSchema = z.object({
  contractVersion: z.literal(1),
  scope: z.literal("account_session"),
  boundary: z.object({
    sequence: z.number().int().nonnegative(),
    cursor: RealtimeCursorSchema,
    capturedAt: TimestampSchema,
    cursorExpiresAt: TimestampSchema
  }).strict(),
  reset: z.object({
    required: z.literal(true),
    collections: z.array(z.enum([
      "message_requests",
      "blocks",
      "chats",
      "members",
      "messages",
      "pins",
      "topics",
      "reactions",
      "receipts",
      "attachments",
      "safety_reports",
      "chat_folders"
    ])).length(12).refine((collections) => new Set(collections).size === 12, {
      message: "Every reconciliation collection must appear exactly once"
    })
  }).strict(),
  resources: z.object({
    incomingMessageRequests: z.literal("/v1/message-requests?direction=incoming"),
    outgoingMessageRequests: z.literal("/v1/message-requests?direction=outgoing"),
    blocks: z.literal("/v2/sync/blocks"),
    chats: z.literal("/v2/sync/chats"),
    attachments: z.literal("/v1/attachments"),
    safetyReports: z.literal("/v1/safety/reports"),
    chatFolders: z.literal("/v1/chat-folders"),
    membersTemplate: z.literal("/v1/chats/{chatId}/members"),
    messagesTemplate: z.literal("/v1/chats/{chatId}/messages"),
    pinsTemplate: z.literal("/v1/chats/{chatId}/pins"),
    topicsTemplate: z.literal("/v1/chats/{chatId}/topics"),
    reactionsTemplate: z.literal("/v1/messages/{messageId}/reactions"),
    receiptsTemplate: z.literal("/v1/messages/{messageId}/receipts")
  }).strict(),
  pagination: z.object({
    cursorParameter: z.literal("cursor"),
    limitParameter: z.literal("limit"),
    nextCursorField: z.literal("nextCursor"),
    maxPageSize: z.literal(100)
  }).strict(),
  resume: z.object({
    websocketPath: z.literal("/v2/realtime"),
    authenticateField: z.literal("resumeCursor"),
    applyEventsIdempotently: z.literal(true),
    sequenceAdjacencyRequired: z.literal(false)
  }).strict()
}).strict();

const RelationshipRequestCreatedForSenderEventSchema = z.object({
  type: z.literal("relationship.request.created"),
  audience: z.literal("sender_account"),
  request: MessageRequestSenderProjectionSchema.extend({ state: z.literal("pending") }).strict()
}).strict();

const RelationshipRequestCreatedForRecipientEventSchema = z.object({
  type: z.literal("relationship.request.created"),
  audience: z.literal("recipient_account"),
  request: MessageRequestRecipientProjectionSchema.extend({ state: z.literal("pending") }).strict()
}).strict();

// These durable event payloads carry explicit privacy audiences. The service
// must route actor_account only to the initiating account and participant_account
// only to the accepted/request participants. Recipient-private removal carries
// no dismissal reason and is never addressable to the sender. There is no
// block-target event or report-subject event.
export const IA1RealtimeEventSchema = z.union([
  RelationshipRequestCreatedForSenderEventSchema,
  RelationshipRequestCreatedForRecipientEventSchema,
  z.object({
    type: z.literal("relationship.request.removed"),
    audience: z.literal("recipient_account"),
    requestId: IdSchema,
    removedAt: TimestampSchema
  }).strict(),
  z.object({
    type: z.literal("relationship.request.accepted"),
    audience: z.literal("participant_account"),
    requestId: IdSchema,
    chat: ChatSchema,
    acceptedAt: TimestampSchema
  }).strict(),
  z.object({
    type: z.literal("relationship.request.expired"),
    audience: z.literal("participant_account"),
    requestId: IdSchema,
    expiredAt: TimestampSchema
  }).strict(),
  z.object({
    type: z.literal("relationship.block.changed"),
    audience: z.literal("actor_account"),
    accountId: IdSchema,
    blocked: z.boolean(),
    changedAt: TimestampSchema
  }).strict(),
  z.object({
    type: z.literal("safety.report.submitted"),
    audience: z.literal("actor_account"),
    report: SafetyReportSummarySchema
  }).strict()
]);

export const RealtimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.created"), chat: ChatSchema }),
  z.object({ type: z.literal("message.created"), message: MessageSchema }),
  z.object({ type: z.literal("message.updated"), message: MessageSchema }),
  z.object({ type: z.literal("message.deleted"), message: MessageSchema }),
  z.object({ type: z.literal("attachment.stored"), attachment: AttachmentSchema }),
  z.object({ type: z.literal("message.pinned"), pin: MessagePinSchema }),
  z.object({ type: z.literal("message.unpinned"), chatId: IdSchema, messageId: IdSchema }),
  z.object({ type: z.literal("topic.created"), topic: TopicSchema }),
  z.object({ type: z.literal("topic.updated"), topic: TopicSchema }),
  z.object({
    type: z.literal("receipt.delivered"),
    chatId: IdSchema,
    userId: IdSchema,
    messageId: IdSchema,
    deliveredAt: TimestampSchema
  }),
  z.object({
    type: z.literal("receipt.read"),
    chatId: IdSchema,
    userId: IdSchema,
    messageId: IdSchema,
    readAt: TimestampSchema
  }),
  z.object({
    type: z.literal("reaction.updated"),
    chatId: IdSchema,
    messageId: IdSchema,
    reactions: z.array(ReactionSummarySchema),
    actorUserId: IdSchema
  })
]);

export const ChatMembershipRealtimeEventSchema = z.object({
  type: z.literal("chat.member.changed"),
  audience: z.enum(["member_account", "removed_account"]),
  change: z.enum(["added", "role_updated", "removed"]),
  membership: ChatMembershipSchema,
  actorUserId: IdSchema,
  changedAt: TimestampSchema
}).strict().superRefine((value, context) => {
  if (value.audience === "removed_account" && value.change !== "removed") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Removed-account audience is valid only for removal",
      path: ["audience"]
    });
  }
  if (value.change === "removed" && value.membership.updatedAt !== value.changedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Removed membership snapshot must use the removal time",
      path: ["changedAt"]
    });
  }
});

export const ChatPreferencesRealtimeEventSchema = z.object({
  type: z.literal("chat.preferences.updated"),
  audience: z.literal("member_account"),
  accountId: IdSchema,
  chatId: IdSchema,
  preferences: ChatPreferencesSchema,
  changedAt: TimestampSchema
}).strict();

export const ChatFoldersRealtimeEventSchema = z.object({
  type: z.literal("chat.folders.updated"),
  audience: z.literal("actor_account"),
  accountId: IdSchema,
  stateRevision: ChatFolderStateRevisionSchema,
  changedAt: TimestampSchema
}).strict();

export const ChatDraftRealtimeEventSchema = z.object({
  type: z.literal("chat.draft.changed"),
  audience: z.literal("account_sessions"),
  accountId: IdSchema,
  chatId: IdSchema,
  draft: ChatDraftSchema.nullable(),
  revision: ActiveDraftRevisionSchema,
  changedAt: TimestampSchema
}).strict().superRefine((event, context) => {
  if (event.draft === null) return;
  if (event.draft.chatId !== event.chatId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Realtime draft must belong to the event chat",
      path: ["draft", "chatId"]
    });
  }
  if (event.draft.revision !== event.revision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Realtime draft and state revisions must match",
      path: ["revision"]
    });
  }
  if (event.draft.updatedAt !== event.changedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Realtime draft timestamp must match the event timestamp",
      path: ["changedAt"]
    });
  }
});

export const SyncInvalidationReasonSchema = z.enum([
  "profile_updated",
  "avatar_updated",
  "attachment_removed",
  "session_list_changed"
]);

export const SyncInvalidatedRealtimeEventSchema = z.object({
  type: z.literal("sync.invalidated"),
  audience: z.literal("account_projection"),
  accountId: IdSchema,
  reason: SyncInvalidationReasonSchema,
  changedAt: TimestampSchema
}).strict();

// Realtime v2 is additive: all existing messaging events remain valid while
// IA-1 and reconciliation-invalidating events are isolated from the strict v1 union.
export const DurableRealtimeEventSchema = z.union([
  RealtimeEventSchema,
  IA1RealtimeEventSchema,
  ChatMembershipRealtimeEventSchema,
  ChatJoinRequestRealtimeEventSchema,
  ChatOwnershipTransferChangedRealtimeEventSchema,
  ChatPreferencesRealtimeEventSchema,
  ChatFoldersRealtimeEventSchema,
  ChatDraftRealtimeEventSchema,
  SyncInvalidatedRealtimeEventSchema
]);

export const ServerRealtimeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    connectionId: IdSchema,
    heartbeatIntervalMs: z.number().int().positive()
  }),
  z.object({
    type: z.literal("ready"),
    userId: IdSchema,
    sessionId: IdSchema,
    sequence: z.number().int().nonnegative(),
    resumed: z.boolean()
  }),
  z.object({
    type: z.literal("dispatch"),
    sequence: z.number().int().positive(),
    event: RealtimeEventSchema
  }),
  z.object({
    type: z.literal("typing.updated"),
    chatId: IdSchema,
    userId: IdSchema,
    isTyping: z.boolean(),
    expiresAt: TimestampSchema
  }),
  z.object({
    type: z.literal("presence.updated"),
    userId: IdSchema,
    presence: z.enum(["online", "offline"]),
    lastSeenAt: TimestampSchema.nullable()
  }),
  z.object({ type: z.literal("heartbeat"), timestamp: TimestampSchema }),
  z.object({ type: z.literal("heartbeat.ack"), timestamp: TimestampSchema }),
  z.object({
    type: z.literal("sync.required"),
    reason: z.enum(["resume_window_exceeded", "backpressure"])
  }),
  z.object({
    type: z.literal("error"),
    code: ApiErrorCodeSchema,
    message: z.string()
  })
]);

export const IA1ServerRealtimeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(IA1_PROTOCOL_VERSION),
    connectionId: IdSchema,
    heartbeatIntervalMs: z.number().int().positive()
  }).strict(),
  z.object({
    type: z.literal("ready"),
    userId: IdSchema,
    sessionId: IdSchema,
    sequence: z.number().int().nonnegative(),
    headSequence: z.number().int().nonnegative(),
    cursor: RealtimeCursorSchema.nullable(),
    resumed: z.boolean(),
    resumeMode: z.enum(["none", "scoped_cursor"]),
    retention: z.object({
      maxReplayEvents: z.literal(REALTIME_MAX_REPLAY_EVENTS),
      cursorTtlSeconds: z.literal(REALTIME_CURSOR_TTL_SECONDS)
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("dispatch"),
    sequence: z.number().int().positive(),
    cursor: RealtimeCursorSchema,
    event: DurableRealtimeEventSchema
  }).strict(),
  z.object({
    type: z.literal("sync.checkpoint"),
    sequence: z.number().int().nonnegative(),
    cursor: RealtimeCursorSchema
  }).strict(),
  z.object({
    type: z.literal("typing.updated"),
    chatId: IdSchema,
    userId: IdSchema,
    isTyping: z.boolean(),
    expiresAt: TimestampSchema
  }).strict(),
  z.object({
    type: z.literal("presence.updated"),
    userId: IdSchema,
    presence: z.enum(["online", "offline"]),
    lastSeenAt: TimestampSchema.nullable()
  }).strict(),
  z.object({ type: z.literal("heartbeat"), timestamp: TimestampSchema }).strict(),
  z.object({ type: z.literal("heartbeat.ack"), timestamp: TimestampSchema }).strict(),
  z.object({
    type: z.literal("sync.required"),
    reason: RealtimeSyncRequiredReasonSchema,
    headSequence: z.number().int().nonnegative(),
    recovery: z.object({
      type: z.literal("http_snapshot"),
      path: z.literal("/v2/sync/snapshot")
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: ApiErrorCodeSchema,
    message: z.string()
  }).strict()
]);

export const ServerRealtimeMessageV2Schema = IA1ServerRealtimeMessageSchema;

export const ClientRealtimeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authenticate"),
    accessToken: z.string().min(20),
    resumeFrom: z.number().int().nonnegative().optional(),
    // The authenticated endpoint owns cursor verification and recovery. Keep
    // this input bounded, but allow corrupted/mixed cursor attempts through so
    // v2 can deterministically issue sync.required instead of a generic parser
    // error. Server-issued cursor fields still use RealtimeCursorSchema.
    resumeCursor: z.string().max(512).optional()
  }).strict(),
  z.object({ type: z.literal("heartbeat"), timestamp: TimestampSchema }).strict(),
  z.object({
    type: z.literal("typing.start"),
    chatId: IdSchema
  }).strict(),
  z.object({
    type: z.literal("typing.stop"),
    chatId: IdSchema
  }).strict(),
  z.object({
    type: z.literal("receipt.delivered"),
    chatId: IdSchema,
    messageId: IdSchema
  }).strict(),
  z.object({
    type: z.literal("receipt.read"),
    chatId: IdSchema,
    messageId: IdSchema
  }).strict()
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type User = z.infer<typeof UserSchema>;
export type PatchCurrentUser = z.infer<typeof PatchCurrentUserSchema>;
export type SetProfileAvatar = z.infer<typeof SetProfileAvatarSchema>;
export type PublicProfile = z.infer<typeof PublicProfileSchema>;
export type UserLookupResponse = z.infer<typeof UserLookupResponseSchema>;
export type MessageRequestPolicy = z.infer<typeof MessageRequestPolicySchema>;
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;
export type PatchPrivacySettings = z.infer<typeof PatchPrivacySettingsSchema>;
export type PushPlatform = z.infer<typeof PushPlatformSchema>;
export type PushEnvironment = z.infer<typeof PushEnvironmentSchema>;
export type UpsertPushRegistration = z.infer<typeof UpsertPushRegistrationSchema>;
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;
export type NotificationPreviewMode = z.infer<typeof NotificationPreviewModeSchema>;
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export type PatchNotificationSettings = z.infer<typeof PatchNotificationSettingsSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type AuthTokens = z.infer<typeof AuthTokensSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type ContainmentScope = z.infer<typeof ContainmentScopeSchema>;
export type ContainmentRequest = z.infer<typeof ContainmentRequestSchema>;
export type ContainmentResponse = z.infer<typeof ContainmentResponseSchema>;
export type PhoneCountryCallingCode = z.infer<typeof PhoneCountryCallingCodeSchema>;
export type PhoneNationalNumber = z.infer<typeof PhoneNationalNumberSchema>;
export type PhoneVerificationCode = z.infer<typeof PhoneVerificationCodeSchema>;
export type RequestPhoneChallenge = z.infer<typeof RequestPhoneChallengeSchema>;
export type PhoneChallengeResponse = z.infer<typeof PhoneChallengeResponseSchema>;
export type VerifyPhoneChallenge = z.infer<typeof VerifyPhoneChallengeSchema>;
export type PhoneAuthenticatedResponse = z.infer<typeof PhoneAuthenticatedResponseSchema>;
export type PhoneProfileRequiredResponse = z.infer<typeof PhoneProfileRequiredResponseSchema>;
export type PhonePasswordRequiredResponse = z.infer<typeof PhonePasswordRequiredResponseSchema>;
export type VerifyPhoneChallengeResponse = z.infer<typeof VerifyPhoneChallengeResponseSchema>;
export type CompletePhonePasswordChallenge = z.infer<typeof CompletePhonePasswordChallengeSchema>;
export type ConfigurePhonePassword = z.infer<typeof ConfigurePhonePasswordSchema>;
export type DisablePhonePassword = z.infer<typeof DisablePhonePasswordSchema>;
export type PhonePasswordStatus = z.infer<typeof PhonePasswordStatusSchema>;
export type CompletePhoneRegistration = z.infer<typeof CompletePhoneRegistrationSchema>;
export type CheckPhoneUsername = z.infer<typeof CheckPhoneUsernameSchema>;
export type PhoneUsernameAvailabilityResponse = z.infer<typeof PhoneUsernameAvailabilityResponseSchema>;
export type StartPhoneRecovery = z.infer<typeof StartPhoneRecoverySchema>;
export type PhoneRecoveryStartedResponse = z.infer<typeof PhoneRecoveryStartedResponseSchema>;
export type CompletePhoneRecovery = z.infer<typeof CompletePhoneRecoverySchema>;
export type StartPhoneBinding = z.infer<typeof StartPhoneBindingSchema>;
export type PhoneBindingChallengeResponse = z.infer<typeof PhoneBindingChallengeResponseSchema>;
export type PhoneBindingVerifiedResponse = z.infer<typeof PhoneBindingVerifiedResponseSchema>;
export type CompletePhoneBinding = z.infer<typeof CompletePhoneBindingSchema>;
export type PhoneBindingCompletedResponse = z.infer<typeof PhoneBindingCompletedResponseSchema>;
export type PasskeyBase64Url = z.infer<typeof PasskeyBase64UrlSchema>;
export type PasskeyChallenge = z.infer<typeof PasskeyChallengeSchema>;
export type PasskeyDeliveryNonce = z.infer<typeof PasskeyDeliveryNonceSchema>;
export type PasskeyUserHandle = z.infer<typeof PasskeyUserHandleSchema>;
export type PasskeyCredentialId = z.infer<typeof PasskeyCredentialIdSchema>;
export type PasskeyClientExtensionResults = z.infer<typeof PasskeyClientExtensionResultsSchema>;
export type PasskeyIdempotencyKey = z.infer<typeof PasskeyIdempotencyKeySchema>;
export type PasskeyCeremonyExpectedRevision = z.infer<typeof PasskeyCeremonyRevisionETagSchema>;
export type PasskeyCredentialContentType = z.infer<typeof PasskeyCredentialContentTypeSchema>;
export type PasskeyCeremonyParams = z.infer<typeof PasskeyCeremonyParamsSchema>;
export type BeginPasskeyRegistrationRequest = z.infer<typeof BeginPasskeyRegistrationRequestSchema>;
export type PasskeyStepUpOperation = z.infer<typeof PasskeyStepUpOperationSchema>;
export type BeginPasskeyStepUpRequest = z.infer<typeof BeginPasskeyStepUpRequestSchema>;
export type BeginPasskeyAuthenticatorRevokeStepUpRequest = z.infer<typeof BeginPasskeyAuthenticatorRevokeStepUpRequestSchema>;
export type PasskeyAuthenticatorRevokeTargetBinding = z.infer<typeof PasskeyAuthenticatorRevokeTargetBindingSchema>;
export type PasskeyStepUpToken = z.infer<typeof PasskeyStepUpTokenSchema>;
export type PasskeyStepUpAuthorizationHeader = z.infer<typeof PasskeyStepUpAuthorizationHeaderSchema>;
export type PasskeyStepUpAuthorization = z.infer<typeof PasskeyStepUpAuthorizationSchema>;
export type PasskeyCredentialDescriptor = z.infer<typeof PasskeyCredentialDescriptorSchema>;
export type PasskeyRegistrationCredentialJSON = z.infer<typeof PasskeyRegistrationCredentialJSONSchema>;
export type PasskeyAuthenticationCredentialJSON = z.infer<typeof PasskeyAuthenticationCredentialJSONSchema>;
export type PasskeyCeremonyVerifyRequest = z.infer<typeof PasskeyCeremonyVerifyRequestSchema>;
export type PasskeyCeremonyState = z.infer<typeof PasskeyCeremonyStateSchema>;
export type PasskeyRegistrationCeremonyPublic = z.infer<typeof PasskeyRegistrationCeremonyPublicSchema>;
export type PasskeyAuthenticationCeremonyPublic = z.infer<typeof PasskeyAuthenticationCeremonyPublicSchema>;
export type PasskeyCeremonyPublic = z.infer<typeof PasskeyCeremonyPublicSchema>;
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptionsSchema>;
export type PasskeyStepUpOptions = z.infer<typeof PasskeyStepUpOptionsSchema>;
export type PasskeyRegistrationBeginResponse = z.infer<typeof PasskeyRegistrationBeginResponseSchema>;
export type PasskeyStepUpBeginResponse = z.infer<typeof PasskeyStepUpBeginResponseSchema>;
export type PasskeyAuthenticatorRevokeStepUpBeginResponse = z.infer<typeof PasskeyAuthenticatorRevokeStepUpBeginResponseSchema>;
export type PasskeyRegistrationVerifyResponse = z.infer<typeof PasskeyRegistrationVerifyResponseSchema>;
export type PasskeyStepUpVerifyResponse = z.infer<typeof PasskeyStepUpVerifyResponseSchema>;
export type PasskeyAuthenticatorRevokeStepUpVerifyResponse = z.infer<typeof PasskeyAuthenticatorRevokeStepUpVerifyResponseSchema>;
export type PasskeyAuthenticatorLifecycleState = z.infer<typeof PasskeyAuthenticatorLifecycleStateSchema>;
export type PasskeyAuthenticatorPublic = z.infer<typeof PasskeyAuthenticatorPublicSchema>;
export type PasskeyAuthenticatorListResponse = z.infer<typeof PasskeyAuthenticatorListResponseSchema>;
export type PasskeyAuthenticatorMutationResponse = z.infer<typeof PasskeyAuthenticatorMutationResponseSchema>;
export type PasskeyAuthenticatorRevokeAuthorization = z.infer<typeof PasskeyAuthenticatorRevokeAuthorizationSchema>;
export type PasskeyAuthenticatorParams = z.infer<typeof PasskeyAuthenticatorParamsSchema>;
export type PasskeyAuthenticatorRenameRequest = z.infer<typeof PasskeyAuthenticatorRenameRequestSchema>;
export type PasskeyAuthenticatorRevokeRequest = z.infer<typeof PasskeyAuthenticatorRevokeRequestSchema>;
export type PasskeyCeremonyVerifyResponse = z.infer<typeof PasskeyCeremonyVerifyResponseSchema>;
export type PasskeyCeremonyErrorReason = z.infer<typeof PasskeyCeremonyErrorReasonSchema>;
export type PasskeyCeremonyError = z.infer<typeof PasskeyCeremonyErrorSchema>;
export type BeginPasskeySignupRequest = z.infer<typeof BeginPasskeySignupRequestSchema>;
export type BeginPasskeyLoginRequest = z.infer<typeof BeginPasskeyLoginRequestSchema>;
export type PasskeyBootstrapPurpose = z.infer<typeof PasskeyBootstrapPurposeSchema>;
export type PasskeyBootstrapToken = z.infer<typeof PasskeyBootstrapTokenSchema>;
export type PasskeyBootstrapAuthorizationHeader = z.infer<typeof PasskeyBootstrapAuthorizationHeaderSchema>;
export type PasskeyBootstrapAuthorization = z.infer<typeof PasskeyBootstrapAuthorizationSchema>;
export type PasskeySignupCeremonyPublic = z.infer<typeof PasskeySignupCeremonyPublicSchema>;
export type PasskeyLoginCeremonyPublic = z.infer<typeof PasskeyLoginCeremonyPublicSchema>;
export type PasskeySignupOptions = z.infer<typeof PasskeySignupOptionsSchema>;
export type PasskeyPrimaryLoginOptions = z.infer<typeof PasskeyPrimaryLoginOptionsSchema>;
export type PasskeySignupBeginResponse = z.infer<typeof PasskeySignupBeginResponseSchema>;
export type PasskeyLoginBeginResponse = z.infer<typeof PasskeyLoginBeginResponseSchema>;
export type VerifyPasskeySignupRequest = z.infer<typeof VerifyPasskeySignupRequestSchema>;
export type VerifyPasskeyLoginRequest = z.infer<typeof VerifyPasskeyLoginRequestSchema>;
export type PasskeySignupVerifyResponse = z.infer<typeof PasskeySignupVerifyResponseSchema>;
export type PasskeyLoginVerifyResponse = z.infer<typeof PasskeyLoginVerifyResponseSchema>;
export type PasskeyBootstrapVerifyResponse = z.infer<typeof PasskeyBootstrapVerifyResponseSchema>;
export type PasskeyPrimaryAuthenticationRejection = z.infer<typeof PasskeyPrimaryAuthenticationRejectionSchema>;
export type ChatKind = z.infer<typeof ChatKindSchema>;
export type ChatRole = z.infer<typeof ChatRoleSchema>;
export type Chat = z.infer<typeof ChatSchema>;
export type ChatPreferences = z.infer<typeof ChatPreferencesSchema>;
export type PatchChatPreferences = z.infer<typeof PatchChatPreferencesSchema>;
export type ChatDraft = z.infer<typeof ChatDraftSchema>;
export type PutChatDraftRequest = z.infer<typeof PutChatDraftRequestSchema>;
export type DeleteChatDraftRequest = z.infer<typeof DeleteChatDraftRequestSchema>;
export type ChatDraftStateResponse = z.infer<typeof ChatDraftStateResponseSchema>;
export type ChatDraftMutationResponse = z.infer<typeof ChatDraftMutationResponseSchema>;
export type ChatFolderRules = z.infer<typeof ChatFolderRulesSchema>;
export type ChatFolderOverrideMode = z.infer<typeof ChatFolderOverrideModeSchema>;
export type ChatFolderOverride = z.infer<typeof ChatFolderOverrideSchema>;
export type ChatFolderOverrides = z.infer<typeof ChatFolderOverridesSchema>;
export type ChatFolder = z.infer<typeof ChatFolderSchema>;
export type CreateChatFolderRequest = z.infer<typeof CreateChatFolderRequestSchema>;
export type PatchChatFolderRequest = z.infer<typeof PatchChatFolderRequestSchema>;
export type DeleteChatFolderRequest = z.infer<typeof DeleteChatFolderRequestSchema>;
export type ReorderChatFoldersRequest = z.infer<typeof ReorderChatFoldersRequestSchema>;
export type ChatFolderListResponse = z.infer<typeof ChatFolderListResponseSchema>;
export type ChatFolderMutationResponse = z.infer<typeof ChatFolderMutationResponseSchema>;
export type ChatFolderDeleteResponse = z.infer<typeof ChatFolderDeleteResponseSchema>;
export type ChatFolderReorderResponse = z.infer<typeof ChatFolderReorderResponseSchema>;
export type ChatMembershipMutableRole = z.infer<typeof ChatMembershipMutableRoleSchema>;
export type ChatMembership = z.infer<typeof ChatMembershipSchema>;
export type ChatMember = z.infer<typeof ChatMemberSchema>;
export type ChatMemberListResponse = z.infer<typeof ChatMemberListResponseSchema>;
export type AddChatMemberRequest = z.infer<typeof AddChatMemberRequestSchema>;
export type UpdateChatMemberRoleRequest = z.infer<typeof UpdateChatMemberRoleRequestSchema>;
export type RemoveChatMemberRequest = z.infer<typeof RemoveChatMemberRequestSchema>;
export type ChatMembershipMutationResponse = z.infer<typeof ChatMembershipMutationResponseSchema>;
export type ChatInviteLink = z.infer<typeof ChatInviteLinkSchema>;
export type CreateChatInviteLinkRequest = z.infer<typeof CreateChatInviteLinkRequestSchema>;
export type CreateChatInviteLinkResponse = z.infer<typeof CreateChatInviteLinkResponseSchema>;
export type ChatInviteLinkListResponse = z.infer<typeof ChatInviteLinkListResponseSchema>;
export type RevokeChatInviteLinkResponse = z.infer<typeof RevokeChatInviteLinkResponseSchema>;
export type JoinChatByInviteRequest = z.infer<typeof JoinChatByInviteRequestSchema>;
export type JoinChatByInviteResponse = z.infer<typeof JoinChatByInviteResponseSchema>;
export type ChatJoinRequestState = z.infer<typeof ChatJoinRequestStateSchema>;
export type ChatJoinRequest = z.infer<typeof ChatJoinRequestSchema>;
export type RequestChatJoinDecision = z.infer<typeof RequestChatJoinDecisionSchema>;
export type ChatJoinRequestListResponse = z.infer<typeof ChatJoinRequestListResponseSchema>;
export type DecideChatJoinRequestResponse = z.infer<typeof DecideChatJoinRequestResponseSchema>;
export type ChatOwnershipTransferState = z.infer<typeof ChatOwnershipTransferStateSchema>;
export type ChatOwnershipTransfer = z.infer<typeof ChatOwnershipTransferSchema>;
export type InitiateOwnershipTransferRequest = z.infer<typeof InitiateOwnershipTransferRequestSchema>;
export type ChatOwnershipTransferResponse = z.infer<typeof ChatOwnershipTransferResponseSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type AttachmentListResponse = z.infer<typeof AttachmentListResponseSchema>;
export type MessageVersion = z.infer<typeof MessageVersionSchema>;
export type MessagePin = z.infer<typeof MessagePinSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
export type EditMessageRequest = z.infer<typeof EditMessageRequestSchema>;
export type PutMessageTranscript = z.infer<typeof PutMessageTranscriptSchema>;
export type ScheduleMessageRequest = z.infer<typeof ScheduleMessageRequestSchema>;
export type ScheduledMessage = z.infer<typeof ScheduledMessageSchema>;
export type ScheduledMessageListResponse = z.infer<typeof ScheduledMessageListResponseSchema>;
export type ForwardMessageRequest = z.infer<typeof ForwardMessageRequestSchema>;
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;
export type UploadSession = z.infer<typeof UploadSessionSchema>;
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;
export type UpdateTopicRequest = z.infer<typeof UpdateTopicRequestSchema>;
export type MessageRequestState = z.infer<typeof MessageRequestStateSchema>;
export type MessageRequestSenderState = z.infer<typeof MessageRequestSenderStateSchema>;
export type CreateMessageRequestInput = z.input<typeof CreateMessageRequestSchema>;
export type CreateMessageRequest = z.output<typeof CreateMessageRequestSchema>;
export type MessageRequestSenderProjection = z.infer<typeof MessageRequestSenderProjectionSchema>;
export type MessageRequestRecipientProjection = z.infer<typeof MessageRequestRecipientProjectionSchema>;
export type MessageRequestProjection = z.infer<typeof MessageRequestProjectionSchema>;
export type CreateMessageRequestResponse = z.infer<typeof CreateMessageRequestResponseSchema>;
export type AcceptedMessageRequest = z.infer<typeof AcceptedMessageRequestSchema>;
export type AcceptMessageRequestResponse = z.infer<typeof AcceptMessageRequestResponseSchema>;
export type MessageRequestListResponse = z.infer<typeof MessageRequestListResponseSchema>;
export type BlockMutationResponse = z.infer<typeof BlockMutationResponseSchema>;
export type BlockedAccountSummary = z.infer<typeof BlockedAccountSummarySchema>;
export type BlockListResponse = z.infer<typeof BlockListResponseSchema>;
export type SafetyReportCategory = z.infer<typeof SafetyReportCategorySchema>;
export type SafetyReportEvidence = z.infer<typeof SafetyReportEvidenceSchema>;
export type CreateSafetyReport = z.infer<typeof CreateSafetyReportSchema>;
export type SafetyReportSummary = z.infer<typeof SafetyReportSummarySchema>;
export type CreateSafetyReportResponse = z.infer<typeof CreateSafetyReportResponseSchema>;
export type SafetyReportListResponse = z.infer<typeof SafetyReportListResponseSchema>;
export type MessageReceipt = z.infer<typeof MessageReceiptSchema>;
export type RealtimeCursor = z.infer<typeof RealtimeCursorSchema>;
export type RealtimeSyncRequiredReason = z.infer<typeof RealtimeSyncRequiredReasonSchema>;
export type RealtimeSnapshotResponse = z.infer<typeof RealtimeSnapshotResponseSchema>;
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
export type IA1RealtimeEvent = z.infer<typeof IA1RealtimeEventSchema>;
export type ChatMembershipRealtimeEvent = z.infer<typeof ChatMembershipRealtimeEventSchema>;
export type ChatPreferencesRealtimeEvent = z.infer<typeof ChatPreferencesRealtimeEventSchema>;
export type ChatFoldersRealtimeEvent = z.infer<typeof ChatFoldersRealtimeEventSchema>;
export type ChatDraftRealtimeEvent = z.infer<typeof ChatDraftRealtimeEventSchema>;
export type SyncInvalidationReason = z.infer<typeof SyncInvalidationReasonSchema>;
export type SyncInvalidatedRealtimeEvent = z.infer<typeof SyncInvalidatedRealtimeEventSchema>;
export type DurableRealtimeEvent = z.infer<typeof DurableRealtimeEventSchema>;
export type ClientRealtimeMessage = z.infer<typeof ClientRealtimeMessageSchema>;
export type ServerRealtimeMessage = z.infer<typeof ServerRealtimeMessageSchema>;
export type IA1ServerRealtimeMessage = z.infer<typeof IA1ServerRealtimeMessageSchema>;
export type ServerRealtimeMessageV2 = z.infer<typeof ServerRealtimeMessageV2Schema>;
export type DataExportState = z.infer<typeof DataExportStateSchema>;
export type DataExportRecord = z.infer<typeof DataExportRecordSchema>;
export type CreateDataExportRequest = z.infer<typeof CreateDataExportRequestSchema>;
export type DataExportRequestResponse = z.infer<typeof DataExportRequestResponseSchema>;
export type DataExportStatusResponse = z.infer<typeof DataExportStatusResponseSchema>;
export type AccountDeletionState = z.infer<typeof AccountDeletionStateSchema>;
export type AccountDeletionRecord = z.infer<typeof AccountDeletionRecordSchema>;
export type AccountDeletionStatusResponse = z.infer<typeof AccountDeletionStatusResponseSchema>;
export type ScheduleAccountDeletionResponse = z.infer<typeof ScheduleAccountDeletionResponseSchema>;
export type CancelAccountDeletionResponse = z.infer<typeof CancelAccountDeletionResponseSchema>;
export type ScheduleAccountDeletionRequest = z.infer<typeof ScheduleAccountDeletionRequestSchema>;
export type CallKind = z.infer<typeof CallKindSchema>;
export type CallMediaMode = z.infer<typeof CallMediaModeSchema>;
export type CallState = z.infer<typeof CallStateSchema>;
export type CallEndReason = z.infer<typeof CallEndReasonSchema>;
export type CallParticipantRole = z.infer<typeof CallParticipantRoleSchema>;
export type CallParticipantStatus = z.infer<typeof CallParticipantStatusSchema>;
export type CallParticipant = z.infer<typeof CallParticipantSchema>;
export type CallResponse = z.infer<typeof CallResponseSchema>;
export type CreateCallRequest = z.infer<typeof CreateCallRequestSchema>;
export type CreateCallResponse = z.infer<typeof CreateCallResponseSchema>;
export type CallStatusResponse = z.infer<typeof CallStatusResponseSchema>;
export type CancelCallRequest = z.infer<typeof CancelCallRequestSchema>;
export type DeclineCallRequest = z.infer<typeof DeclineCallRequestSchema>;
export type InviteCallParticipantRequest = z.infer<typeof InviteCallParticipantRequestSchema>;
export type CallTrackSource = z.infer<typeof CallTrackSourceSchema>;
export type JoinGrantRequest = z.infer<typeof JoinGrantRequestSchema>;
export type JoinGrantResponse = z.infer<typeof JoinGrantResponseSchema>;
export type HangupCallRequest = z.infer<typeof HangupCallRequestSchema>;
export type DeviceLinkChallengeState = z.infer<typeof DeviceLinkChallengeStateSchema>;
export type CreateDeviceLinkChallengeRequest = z.infer<typeof CreateDeviceLinkChallengeRequestSchema>;
export type CreateDeviceLinkChallengeResponse = z.infer<typeof CreateDeviceLinkChallengeResponseSchema>;
export type DeviceLinkChallenge = z.infer<typeof DeviceLinkChallengeSchema>;
export type DeviceLinkChallengeResponse = z.infer<typeof DeviceLinkChallengeResponseSchema>;
export type DeviceLinkProofKey = z.infer<typeof DeviceLinkProofKeySchema>;
export type DeviceLinkRedeemRequest = z.infer<typeof DeviceLinkRedeemRequestSchema>;
export type DeviceLinkRedeemResponse = z.infer<typeof DeviceLinkRedeemResponseSchema>;