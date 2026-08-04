import { createHash, generateKeyPairSync, sign as signData } from "node:crypto";

import type {
  AuthenticationVerificationExpectations,
  DiscoverableLoginVerificationExpectations,
  RegistrationVerificationExpectations
} from "@luxora/passkey-domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PasskeyVerifierUnavailableError,
  SimpleWebAuthnVerifierAdapter,
  type BootstrapRegistrationCeremony,
  type PasskeyCredentialRepository,
  type SimpleWebAuthnPrimitives,
  type StoredPasskeyCredential,
  type StoredPasskeyUserHandle
} from "./simplewebauthn-adapter.js";

const RP_ID = "auth.luxora.example";
const ORIGIN = `https://${RP_ID}`;
const CHALLENGE = Buffer.alloc(32, 0x31).toString("base64url");
const CREDENTIAL_ID = Buffer.from("credential-id-1").toString("base64url");
const USER_HANDLE = new Uint8Array(32).fill(0x42);
const USER_HANDLE_B64 = Buffer.from(USER_HANDLE).toString("base64url");
const PUBLIC_KEY = new Uint8Array([0xa5, 0x01, 0x02, 0x03]);
const CANDIDATE_ACCOUNT_ID = "018f47a4-7e3b-7d4a-8b6c-0123456789ab";

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function cborText(value: string): Uint8Array {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > 23) throw new Error("fixture text is too long");
  return concatBytes(Uint8Array.of(0x60 + encoded.byteLength), encoded);
}

function cborBytes(value: Uint8Array): Uint8Array {
  if (value.byteLength <= 23) {
    return concatBytes(Uint8Array.of(0x40 + value.byteLength), value);
  }
  if (value.byteLength <= 0xff) {
    return concatBytes(Uint8Array.of(0x58, value.byteLength), value);
  }
  if (value.byteLength <= 0xffff) {
    return concatBytes(
      Uint8Array.of(0x59, (value.byteLength >> 8) & 0xff, value.byteLength & 0xff),
      value
    );
  }
  throw new Error("fixture bytes are too long");
}

function validNoneAttestationObject(rpId = RP_ID, algorithm: -7 | -8 = -7): string {
  const credentialId = Buffer.from(CREDENTIAL_ID, "base64url");
  const coseKey = concatBytes(
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, algorithm === -7 ? 0x26 : 0x27, 0x20, 0x01, 0x21),
    cborBytes(new Uint8Array(32).fill(0x11)),
    Uint8Array.of(0x22),
    cborBytes(new Uint8Array(32).fill(0x22))
  );
  const authData = concatBytes(
    createHash("sha256").update(rpId, "utf8").digest(),
    Uint8Array.of(0x45), // UP + UV + attested credential data
    Uint8Array.of(0, 0, 0, 0),
    new Uint8Array(16),
    Uint8Array.of((credentialId.byteLength >> 8) & 0xff, credentialId.byteLength & 0xff),
    credentialId,
    coseKey
  );
  const attestationObject = concatBytes(
    Uint8Array.of(0xa3),
    cborText("fmt"), cborText("none"),
    cborText("attStmt"), Uint8Array.of(0xa0),
    cborText("authData"), cborBytes(authData)
  );
  return Buffer.from(attestationObject).toString("base64url");
}

function realEs256RegistrationFixture(options: {
  readonly challenge?: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly flags?: number;
  readonly format?: "none" | "packed";
  readonly tamperSignature?: boolean;
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("fixture EC key is invalid");
  const coseKey = concatBytes(
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
    cborBytes(Buffer.from(jwk.x, "base64url")),
    Uint8Array.of(0x22),
    cborBytes(Buffer.from(jwk.y, "base64url"))
  );
  const credentialId = Buffer.from(CREDENTIAL_ID, "base64url");
  const authenticatorData = concatBytes(
    createHash("sha256").update(options.rpId ?? RP_ID, "utf8").digest(),
    Uint8Array.of(options.flags ?? 0x45), // UP + UV + attested credential data
    Uint8Array.of(0, 0, 0, 0),
    new Uint8Array(16),
    Uint8Array.of((credentialId.byteLength >> 8) & 0xff, credentialId.byteLength & 0xff),
    credentialId,
    coseKey
  );
  const encodedClientData = clientData(
    "webauthn.create",
    options.challenge ?? CHALLENGE,
    options.origin ?? ORIGIN
  );
  const format = options.format ?? "none";
  let attestationStatement: Uint8Array;
  if (format === "none") {
    attestationStatement = Uint8Array.of(0xa0);
  } else {
    const signatureBase = concatBytes(
      authenticatorData,
      createHash("sha256").update(Buffer.from(encodedClientData, "base64url")).digest()
    );
    const signature = signData("sha256", signatureBase, privateKey);
    if (options.tamperSignature === true) {
      signature[signature.byteLength - 1] = (signature[signature.byteLength - 1] ?? 0) ^ 0x01;
    }
    attestationStatement = concatBytes(
      Uint8Array.of(0xa2),
      cborText("alg"), Uint8Array.of(0x26),
      cborText("sig"), cborBytes(signature)
    );
  }
  const attestationObject = concatBytes(
    Uint8Array.of(0xa3),
    cborText("fmt"), cborText(format),
    cborText("attStmt"), attestationStatement,
    cborText("authData"), cborBytes(authenticatorData)
  );
  return registrationResponse({
    response: {
      clientDataJSON: encodedClientData,
      attestationObject: Buffer.from(attestationObject).toString("base64url"),
      transports: ["internal"]
    }
  });
}

function signedAuthenticationFixture(
  counter: number,
  options: {
    readonly flags?: number;
    readonly signedRpId?: string;
    readonly type?: string;
    readonly challenge?: string;
    readonly origin?: string;
  } = {}
): {
  readonly response: ReturnType<typeof authenticationResponse>;
  readonly credentialPublicKey: Uint8Array;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("fixture EC key is invalid");
  const credentialPublicKey = concatBytes(
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
    cborBytes(Buffer.from(jwk.x, "base64url")),
    Uint8Array.of(0x22),
    cborBytes(Buffer.from(jwk.y, "base64url"))
  );
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = concatBytes(
    createHash("sha256").update(options.signedRpId ?? RP_ID, "utf8").digest(),
    Uint8Array.of(options.flags ?? 0x05), // UP + UV by default
    counterBytes
  );
  const encodedClientData = clientData(
    options.type ?? "webauthn.get",
    options.challenge ?? CHALLENGE,
    options.origin ?? ORIGIN
  );
  const signatureBase = concatBytes(
    authenticatorData,
    createHash("sha256").update(Buffer.from(encodedClientData, "base64url")).digest()
  );
  const signature = signData("sha256", signatureBase, privateKey);
  return {
    response: authenticationResponse({
      response: {
        clientDataJSON: encodedClientData,
        authenticatorData: Buffer.from(authenticatorData).toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: USER_HANDLE_B64
      }
    }),
    credentialPublicKey
  };
}

function signedRs256AuthenticationFixture(counter: number): {
  readonly response: ReturnType<typeof authenticationResponse>;
  readonly credentialPublicKey: Uint8Array;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    publicExponent: 0x10001
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("fixture RSA key is invalid");
  const credentialPublicKey = concatBytes(
    Uint8Array.of(
      0xa4,
      0x01, 0x03, // kty: RSA
      0x03, 0x39, 0x01, 0x00, // alg: -257
      0x20
    ),
    cborBytes(Buffer.from(jwk.n, "base64url")),
    Uint8Array.of(0x21),
    cborBytes(Buffer.from(jwk.e, "base64url"))
  );
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = concatBytes(
    createHash("sha256").update(RP_ID, "utf8").digest(),
    Uint8Array.of(0x05),
    counterBytes
  );
  const encodedClientData = clientData("webauthn.get");
  const signatureBase = concatBytes(
    authenticatorData,
    createHash("sha256").update(Buffer.from(encodedClientData, "base64url")).digest()
  );
  const signature = signData("sha256", signatureBase, privateKey);
  return {
    response: authenticationResponse({
      response: {
        clientDataJSON: encodedClientData,
        authenticatorData: Buffer.from(authenticatorData).toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: USER_HANDLE_B64
      }
    }),
    credentialPublicKey
  };
}

function clientData(type: string, challenge = CHALLENGE, origin = ORIGIN, extra: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin, ...extra })).toString("base64url");
}

function registrationResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    response: {
      clientDataJSON: clientData("webauthn.create"),
      attestationObject: validNoneAttestationObject(),
      transports: ["internal"]
    },
    clientExtensionResults: {},
    type: "public-key",
    ...overrides
  };
}

function authenticationResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    response: {
      clientDataJSON: clientData("webauthn.get"),
      authenticatorData: Buffer.from([0x01]).toString("base64url"),
      signature: Buffer.from([0x02]).toString("base64url"),
      userHandle: USER_HANDLE_B64
    },
    clientExtensionResults: {},
    type: "public-key",
    ...overrides
  };
}

const registrationExpectations = (): RegistrationVerificationExpectations => ({
  kind: "registration",
  expectedChallenge: CHALLENGE,
  expectedRpId: RP_ID,
  expectedOrigin: ORIGIN,
  expectedTopOrigins: [],
  crossOriginAllowed: false,
  requireUserPresence: true,
  requireUserVerification: true,
  attestation: "none",
  residentKey: "required",
  allowedAlgorithms: [-7, -257],
  expectedAccountId: "account-1",
  expectedUserHandleRef: "handle-ref-1",
  purpose: { type: "authenticator.add", targetDigest: "a".repeat(64) },
  maxResponseBytes: 65_536,
  responseByteLength: 512
});

const bootstrapRegistrationCeremony = (): BootstrapRegistrationCeremony => ({
  kind: "bootstrap_registration",
  rpName: "Luxora",
  userName: "flenym",
  userDisplayName: "Flenym",
  expectedChallenge: CHALLENGE,
  expectedRpId: RP_ID,
  expectedOrigin: ORIGIN,
  expectedTopOrigins: [],
  crossOriginAllowed: false,
  timeoutMs: 300_000,
  requireUserPresence: true,
  requireUserVerification: true,
  attestation: "none",
  residentKey: "required",
  allowedAlgorithms: [-7, -257],
  excludeCredentials: [],
  candidateAccountId: CANDIDATE_ACCOUNT_ID,
  userHandleRef: "candidate-user-handle-ref-1",
  expectedUserHandle: new Uint8Array(USER_HANDLE)
});

const authenticationExpectations = (): AuthenticationVerificationExpectations => ({
  kind: "authentication",
  expectedChallenge: CHALLENGE,
  expectedRpId: RP_ID,
  expectedOrigin: ORIGIN,
  expectedTopOrigins: [],
  crossOriginAllowed: false,
  requireUserPresence: true,
  requireUserVerification: true,
  allowedAlgorithms: [-7, -257],
  expectedAccountId: "account-1",
  credentialBoundary: { mode: "discoverable", credentialSetRef: null },
  purpose: { type: "session.step_up", targetDigest: "b".repeat(64) },
  maxResponseBytes: 65_536,
  responseByteLength: 384
});

const discoverableLoginExpectations = (): DiscoverableLoginVerificationExpectations => ({
  kind: "authentication",
  expectedChallenge: CHALLENGE,
  expectedRpId: RP_ID,
  expectedOrigin: ORIGIN,
  expectedTopOrigins: [],
  crossOriginAllowed: false,
  requireUserPresence: true,
  requireUserVerification: true,
  allowedAlgorithms: [-7, -257],
  credentialBoundary: { mode: "discoverable_any", credentialSetRef: null },
  purpose: { type: "session.create", targetDigest: "c".repeat(64) },
  maxResponseBytes: 65_536,
  responseByteLength: 384
});

const storedHandle = (): StoredPasskeyUserHandle => ({
  userHandleRef: "handle-ref-1",
  accountId: "account-1",
  userHandle: new Uint8Array(USER_HANDLE)
});

const storedCredential = (overrides: Partial<StoredPasskeyCredential> = {}): StoredPasskeyCredential => ({
  credentialRecordId: "credential-record-1",
  credentialRevision: 4,
  credentialId: CREDENTIAL_ID,
  publicKey: new Uint8Array(PUBLIC_KEY),
  algorithm: -7,
  accountId: "account-1",
  userHandleRef: "handle-ref-1",
  discoveryMode: "discoverable",
  credentialSetRef: null,
  signCount: 7,
  backupEligible: true,
  backupState: false,
  transports: ["internal"],
  ...overrides
});

class TestRepository implements PasskeyCredentialRepository {
  handle: StoredPasskeyUserHandle | null = storedHandle();
  credential: StoredPasskeyCredential | null = storedCredential();
  credentials: readonly StoredPasskeyCredential[] = [storedCredential()];
  readonly credentialIdLookups: string[] = [];
  readonly recordIdLookups: string[] = [];

  async findPasskeyUserHandleByRef(): Promise<StoredPasskeyUserHandle | null> {
    return this.handle;
  }

  async findPasskeyCredentialById(credentialId: string): Promise<StoredPasskeyCredential | null> {
    this.credentialIdLookups.push(credentialId);
    return this.credential;
  }

  async findPasskeyCredentialByRecordId(credentialRecordId: string): Promise<StoredPasskeyCredential | null> {
    this.recordIdLookups.push(credentialRecordId);
    return this.credential;
  }

  async listPasskeyCredentialsByAccountId(): Promise<readonly StoredPasskeyCredential[]> {
    return this.credentials;
  }
}

function decodeClientData(encoded: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

function fakePrimitives(overrides: Partial<SimpleWebAuthnPrimitives> = {}): SimpleWebAuthnPrimitives {
  const defaults: SimpleWebAuthnPrimitives = {
    async generateRegistrationOptions(options) {
      return {
        rp: { id: options.rpID, name: options.rpName },
        user: {
          id: Buffer.from(options.userID ?? new Uint8Array()).toString("base64url"),
          name: options.userName,
          displayName: options.userDisplayName ?? ""
        },
        challenge: typeof options.challenge === "string"
          ? Buffer.from(options.challenge).toString("base64url")
          : Buffer.from(options.challenge ?? new Uint8Array()).toString("base64url"),
        pubKeyCredParams: (options.supportedAlgorithmIDs ?? []).map((alg) => ({ alg, type: "public-key" })),
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, type: "public-key" })),
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestationType
      };
    },
    async generateAuthenticationOptions(options) {
      return {
        challenge: typeof options.challenge === "string"
          ? Buffer.from(options.challenge).toString("base64url")
          : Buffer.from(options.challenge ?? new Uint8Array()).toString("base64url"),
        timeout: options.timeout,
        rpId: options.rpID,
        ...(options.allowCredentials === undefined ? {} : { allowCredentials: options.allowCredentials.map((item) => ({ ...item, type: "public-key" })) }),
        userVerification: options.userVerification
      };
    },
    async verifyRegistrationResponse(options) {
      const collected = decodeClientData(options.response.response.clientDataJSON);
      if (
        collected["type"] !== options.expectedType
        || collected["challenge"] !== options.expectedChallenge
        || collected["origin"] !== options.expectedOrigin
        || options.expectedRPID !== RP_ID
      ) throw new Error("maintained verifier rejection");
      return {
        verified: true,
        registrationInfo: {
          fmt: "none",
          aaguid: "00000000-0000-0000-0000-000000000000",
          credential: {
            id: CREDENTIAL_ID,
            publicKey: new Uint8Array(PUBLIC_KEY),
            counter: 0,
            transports: ["internal"]
          },
          credentialType: "public-key",
          attestationObject: new Uint8Array([0xa0]),
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: ORIGIN,
          rpID: RP_ID
        }
      };
    },
    async verifyAuthenticationResponse(options) {
      const collected = decodeClientData(options.response.response.clientDataJSON);
      if (
        collected["type"] !== options.expectedType
        || collected["challenge"] !== options.expectedChallenge
        || collected["origin"] !== options.expectedOrigin
        || options.expectedRPID !== RP_ID
      ) throw new Error("maintained verifier rejection");
      return {
        verified: true,
        authenticationInfo: {
          credentialID: CREDENTIAL_ID,
          newCounter: 8,
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: ORIGIN,
          rpID: RP_ID
        }
      };
    },
    decodeCredentialPublicKey() {
      return new Map<number, number>([[3, -7]]);
    }
  };
  return { ...defaults, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SimpleWebAuthnVerifierAdapter bootstrap registration", () => {
  it("generates the exact repository-free first-authenticator policy", async () => {
    const repository = new TestRepository();
    const lookups = [
      vi.spyOn(repository, "findPasskeyUserHandleByRef"),
      vi.spyOn(repository, "findPasskeyCredentialById"),
      vi.spyOn(repository, "findPasskeyCredentialByRecordId"),
      vi.spyOn(repository, "listPasskeyCredentialsByAccountId")
    ];
    let captured: Parameters<SimpleWebAuthnPrimitives["generateRegistrationOptions"]>[0] | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async generateRegistrationOptions(options) {
        captured = options;
        return fakePrimitives().generateRegistrationOptions(options);
      }
    }));

    const result = await adapter.createBootstrapRegistrationOptions(bootstrapRegistrationCeremony());

    expect(captured).toMatchObject({
      rpName: "Luxora",
      rpID: RP_ID,
      userName: "flenym",
      userDisplayName: "Flenym",
      timeout: 300_000,
      attestationType: "none",
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required"
      },
      supportedAlgorithmIDs: [-7, -257]
    });
    expect(Buffer.from(captured?.challenge as Uint8Array).toString("base64url")).toBe(CHALLENGE);
    expect(Buffer.from(captured?.userID ?? []).toString("base64url")).toBe(USER_HANDLE_B64);
    expect(result).toMatchObject({
      challenge: CHALLENGE,
      rp: { id: RP_ID, name: "Luxora" },
      user: { id: USER_HANDLE_B64, name: "flenym", displayName: "Flenym" },
      pubKeyCredParams: [{ alg: -7 }, { alg: -257 }],
      excludeCredentials: [],
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required"
      }
    });
    for (const lookup of lookups) expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the exact bootstrap policy through the real maintained generator", async () => {
    const options = await new SimpleWebAuthnVerifierAdapter(new TestRepository())
      .createBootstrapRegistrationOptions(bootstrapRegistrationCeremony());

    expect(options).toMatchObject({
      challenge: CHALLENGE,
      rp: { id: RP_ID, name: "Luxora" },
      user: { id: USER_HANDLE_B64, name: "flenym", displayName: "Flenym" },
      pubKeyCredParams: [{ alg: -7 }, { alg: -257 }],
      excludeCredentials: [],
      timeout: 300_000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required"
      }
    });
  });

  it("verifies a real ES256 none-attestation fixture without repository lookup and returns only commit material", async () => {
    const repository = new TestRepository();
    const lookups = [
      vi.spyOn(repository, "findPasskeyUserHandleByRef"),
      vi.spyOn(repository, "findPasskeyCredentialById"),
      vi.spyOn(repository, "findPasskeyCredentialByRecordId"),
      vi.spyOn(repository, "listPasskeyCredentialsByAccountId")
    ];
    const result = await new SimpleWebAuthnVerifierAdapter(repository)
      .verifyBootstrapRegistration(realEs256RegistrationFixture(), bootstrapRegistrationCeremony());

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified bootstrap fixture");
    expect(result).toMatchObject({
      status: "verified",
      kind: "bootstrap_registration",
      candidate: {
        accountId: CANDIDATE_ACCOUNT_ID,
        userHandleRef: "candidate-user-handle-ref-1",
        expectedUserHandle: USER_HANDLE,
        userName: "flenym",
        userDisplayName: "Flenym"
      },
      credential: {
        credentialId: CREDENTIAL_ID,
        algorithm: -7,
        discoveryMode: "discoverable",
        signCount: 0,
        backupEligible: false,
        backupState: false,
        transports: ["internal"],
        userPresent: true,
        userVerified: true
      }
    });
    expect(result.credential.publicKey.byteLength).toBeGreaterThan(0);
    expect(Object.keys(result).sort()).toEqual(["candidate", "credential", "kind", "status"]);
    expect(JSON.stringify(result)).not.toMatch(/challenge|clientData|attestationObject|origin|rpId/i);
    for (const lookup of lookups) expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["origin", { origin: "https://evil.example" }],
    ["challenge", { challenge: Buffer.alloc(32, 0x77).toString("base64url") }],
    ["user verification", { flags: 0x41 }]
  ] as const)("coarsens real maintained-verifier rejection for wrong %s", async (_label, fixtureOptions) => {
    await expect(new SimpleWebAuthnVerifierAdapter(new TestRepository())
      .verifyBootstrapRegistration(realEs256RegistrationFixture(fixtureOptions), bootstrapRegistrationCeremony()))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });

  it("uses the maintained verifier for a packed ES256 signature before enforcing none attestation", async () => {
    const validPacked = realEs256RegistrationFixture({ format: "packed" });
    const tamperedPacked = realEs256RegistrationFixture({ format: "packed", tamperSignature: true });
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository());

    await expect(adapter.verifyBootstrapRegistration(validPacked, bootstrapRegistrationCeremony()))
      .resolves.toEqual({ status: "rejected", reason: "policy_rejected" });
    await expect(adapter.verifyBootstrapRegistration(tamperedPacked, bootstrapRegistrationCeremony()))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });

  it("rejects hostile ceremony shapes and coercion before invoking the maintained primitive", async () => {
    const generate = vi.fn<SimpleWebAuthnPrimitives["generateRegistrationOptions"]>();
    const verify = vi.fn<SimpleWebAuthnPrimitives["verifyRegistrationResponse"]>();
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      generateRegistrationOptions: generate,
      verifyRegistrationResponse: verify
    }));
    const valid = bootstrapRegistrationCeremony();
    const cases = [
      { ...valid, candidateAccountId: CANDIDATE_ACCOUNT_ID.toUpperCase() },
      { ...valid, allowedAlgorithms: ["-7", -257] },
      { ...valid, expectedUserHandle: USER_HANDLE_B64 },
      { ...valid, excludeCredentials: [{ id: CREDENTIAL_ID }] },
      { ...valid, ignoredAccountHint: "account-elsewhere" }
    ];

    for (const hostile of cases) {
      await expect(adapter.createBootstrapRegistrationOptions(hostile as unknown as BootstrapRegistrationCeremony))
        .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
      await expect(adapter.verifyBootstrapRegistration(registrationResponse(), hostile as unknown as BootstrapRegistrationCeremony))
        .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
    }
    expect(generate).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects accessor, symbol and proxy canaries without leaking their causes", async () => {
    const accessor = { ...bootstrapRegistrationCeremony() } as Record<string, unknown>;
    Object.defineProperty(accessor, "candidateAccountId", {
      enumerable: true,
      get() { throw new Error("bootstrap-accessor-CANARY"); }
    });
    const symbol = { ...bootstrapRegistrationCeremony(), [Symbol("bootstrap-symbol-CANARY")]: true };
    const proxy = new Proxy(new Uint8Array(USER_HANDLE), {
      getPrototypeOf() { throw new Error("bootstrap-proxy-CANARY"); }
    });
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives());
    const cases = [
      accessor,
      symbol,
      { ...bootstrapRegistrationCeremony(), expectedUserHandle: proxy }
    ];

    for (const hostile of cases) {
      const thrown = await adapter.createBootstrapRegistrationOptions(hostile as BootstrapRegistrationCeremony)
        .then(() => null, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(PasskeyVerifierUnavailableError);
      expect(String(thrown)).toBe("PasskeyVerifierUnavailableError: passkey verifier unavailable");
      expect(String(thrown)).not.toContain("CANARY");
    }
  });

  it("fails closed on a generator that omits the explicit empty exclude list", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async generateRegistrationOptions(options) {
        const generated = await fakePrimitives().generateRegistrationOptions(options) as Record<string, unknown>;
        const { excludeCredentials: _ignored, ...withoutExcludeCredentials } = generated;
        return withoutExcludeCredentials;
      }
    }));

    await expect(adapter.createBootstrapRegistrationOptions(bootstrapRegistrationCeremony()))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
  });

  it("rejects accessor-shaped maintained-verifier output without reading or leaking it", async () => {
    const hostileOutput = { verified: true } as Record<string, unknown>;
    Object.defineProperty(hostileOutput, "registrationInfo", {
      enumerable: true,
      get() { throw new Error("bootstrap-verifier-output-CANARY"); }
    });
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async verifyRegistrationResponse() { return hostileOutput; }
    }));

    const thrown = await adapter.verifyBootstrapRegistration(registrationResponse(), bootstrapRegistrationCeremony())
      .then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(PasskeyVerifierUnavailableError);
    expect(String(thrown)).toBe("PasskeyVerifierUnavailableError: passkey verifier unavailable");
    expect(String(thrown)).not.toContain("CANARY");
  });
});

describe("SimpleWebAuthnVerifierAdapter options", () => {
  it("generates exact resident-key registration policy from the stable opaque handle", async () => {
    const repository = new TestRepository();
    let captured: Parameters<SimpleWebAuthnPrimitives["generateRegistrationOptions"]>[0] | undefined;
    const primitives = fakePrimitives({
      async generateRegistrationOptions(options) {
        captured = options;
        return fakePrimitives().generateRegistrationOptions(options);
      }
    });
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, primitives);

    const options = await adapter.createRegistrationOptions({
      rpName: "Luxora",
      userName: "flenym",
      userDisplayName: "Flenym",
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      expectedUserHandleRef: "handle-ref-1"
    });

    expect(captured).toMatchObject({
      rpName: "Luxora",
      rpID: RP_ID,
      userName: "flenym",
      userDisplayName: "Flenym",
      timeout: 300_000,
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" }
    });
    expect(Buffer.from(captured?.challenge as Uint8Array).toString("base64url")).toBe(CHALLENGE);
    expect(Buffer.from(captured?.userID ?? []).toString("base64url")).toBe(USER_HANDLE_B64);
    expect(captured?.excludeCredentials).toEqual([{ id: CREDENTIAL_ID, transports: ["internal"] }]);
    expect(options.excludeCredentials).toEqual([{ id: CREDENTIAL_ID, transports: ["internal"], type: "public-key" }]);
    expect(options.user).toEqual({ id: USER_HANDLE_B64, name: "flenym", displayName: "Flenym" });
  });

  it("omits allowCredentials for discoverable authentication", async () => {
    let captured: Parameters<SimpleWebAuthnPrimitives["generateAuthenticationOptions"]>[0] | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async generateAuthenticationOptions(options) {
        captured = options;
        return fakePrimitives().generateAuthenticationOptions(options);
      }
    }));

    const options = await adapter.createAuthenticationOptions({
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      credentialBoundary: { mode: "discoverable", credentialSetRef: null }
    });

    expect(captured).not.toHaveProperty("allowCredentials");
    expect(options).not.toHaveProperty("allowCredentials");
    expect(options.userVerification).toBe("required");
  });

  it("creates identifier-free login options without any account or credential lookup", async () => {
    const repository = new TestRepository();
    const credentialLookup = vi.spyOn(repository, "findPasskeyCredentialById");
    const handleLookup = vi.spyOn(repository, "findPasskeyUserHandleByRef");
    let captured: Parameters<SimpleWebAuthnPrimitives["generateAuthenticationOptions"]>[0] | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async generateAuthenticationOptions(options) {
        captured = options;
        const generated = await fakePrimitives().generateAuthenticationOptions(options) as Record<string, unknown>;
        return {
          ...generated,
          allowCredentials: []
        };
      }
    }));

    const options = await adapter.createDiscoverableLoginOptions({
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      credentialBoundary: { mode: "discoverable_any", credentialSetRef: null }
    });

    expect(captured).toMatchObject({
      rpID: RP_ID,
      timeout: 300_000,
      userVerification: "required"
    });
    expect(Buffer.from(captured?.challenge as Uint8Array).toString("base64url")).toBe(CHALLENGE);
    expect(options).not.toHaveProperty("allowCredentials");
    expect(options).toMatchObject({
      challenge: CHALLENGE,
      timeout: 300_000,
      rpId: RP_ID,
      userVerification: "required"
    });
    expect(credentialLookup).not.toHaveBeenCalled();
    expect(handleLookup).not.toHaveBeenCalled();
  });

  it("rejects unrequested hints and extensions from a hostile login-options generator", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async generateAuthenticationOptions(options) {
        const generated = await fakePrimitives().generateAuthenticationOptions(options) as Record<string, unknown>;
        return {
          ...generated,
          hints: ["client-device"],
          extensions: { appid: "https://attacker.example" }
        };
      }
    }));

    await expect(adapter.createDiscoverableLoginOptions({
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      credentialBoundary: { mode: "discoverable_any", credentialSetRef: null }
    })).rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
  });

  it("preserves the ceremony challenge exactly through the real maintained generators", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository());

    const registration = await adapter.createRegistrationOptions({
      rpName: "Luxora",
      userName: "flenym",
      userDisplayName: "Flenym",
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      expectedUserHandleRef: "handle-ref-1"
    });
    const authentication = await adapter.createAuthenticationOptions({
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      credentialBoundary: { mode: "discoverable", credentialSetRef: null }
    });

    expect(registration.challenge).toBe(CHALLENGE);
    expect(authentication.challenge).toBe(CHALLENGE);
    expect(registration.excludeCredentials).toEqual([{ id: CREDENTIAL_ID, transports: ["internal"], type: "public-key" }]);
  });

  it("resolves a non-discoverable boundary by opaque record ref", async () => {
    const repository = new TestRepository();
    repository.credential = storedCredential({
      credentialRecordId: "credential-record-1",
      discoveryMode: "non_discoverable",
      credentialSetRef: "credential-record-1"
    });
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives());

    const options = await adapter.createAuthenticationOptions({
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      credentialBoundary: { mode: "non_discoverable", credentialSetRef: "credential-record-1" }
    });

    expect(repository.recordIdLookups).toEqual(["credential-record-1"]);
    expect(options.allowCredentials).toEqual([{ id: CREDENTIAL_ID, transports: ["internal"], type: "public-key" }]);
  });

  it("treats malformed option-generator output as unavailable", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async generateRegistrationOptions() {
        return { challenge: CHALLENGE };
      }
    }));

    await expect(adapter.createRegistrationOptions({
      rpName: "Luxora",
      userName: "flenym",
      userDisplayName: "Flenym",
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      expectedUserHandleRef: "handle-ref-1"
    })).rejects.toEqual(expect.objectContaining({ name: "PasskeyVerifierUnavailableError", message: "passkey verifier unavailable" }));
  });

  it("fails closed before generation when an account exceeds the platform limit of 20 credentials", async () => {
    const repository = new TestRepository();
    repository.credentials = Array.from({ length: 21 }, (_, index) => storedCredential({
      credentialRecordId: `credential-record-${index}`,
      credentialId: Buffer.from(`credential-id-${index}`).toString("base64url")
    }));
    const generate = vi.fn<SimpleWebAuthnPrimitives["generateRegistrationOptions"]>();
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({ generateRegistrationOptions: generate }));

    await expect(adapter.createRegistrationOptions({
      rpName: "Luxora",
      userName: "flenym",
      userDisplayName: "Flenym",
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      allowedAlgorithms: [-7, -257],
      expectedAccountId: "account-1",
      expectedUserHandleRef: "handle-ref-1"
    })).rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("SimpleWebAuthnVerifierAdapter registration verification", () => {
  it("maps maintained-library credential, COSE algorithm, transports and BE/BS", async () => {
    let captured: Parameters<SimpleWebAuthnPrimitives["verifyRegistrationResponse"]>[0] | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async verifyRegistrationResponse(options) {
        captured = options;
        return fakePrimitives().verifyRegistrationResponse(options);
      }
    }));

    const result = await adapter.verifyRegistration(registrationResponse(), registrationExpectations());

    expect(captured).toMatchObject({
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257]
    });
    expect(result).toEqual({
      status: "verified",
      kind: "registration",
      credential: {
        credentialId: CREDENTIAL_ID,
        publicKey: PUBLIC_KEY,
        algorithm: -7,
        accountId: "account-1",
        userHandleRef: "handle-ref-1",
        discoveryMode: "discoverable",
        signCount: 0,
        backupEligible: true,
        backupState: true,
        transports: ["internal"],
        userPresent: true,
        userVerified: true
      }
    });
  });

  it.each([
    ["wrong origin", clientData("webauthn.create", CHALLENGE, "https://evil.example")],
    ["wrong challenge", clientData("webauthn.create", Buffer.alloc(32, 0x77).toString("base64url"), ORIGIN)],
    ["wrong ceremony type", clientData("webauthn.get", CHALLENGE, ORIGIN)]
  ])("normalizes %s library rejection", async (_label, clientDataJSON) => {
    const response = registrationResponse({
      response: {
        clientDataJSON,
        attestationObject: Buffer.from([0xa0]).toString("base64url"),
        transports: ["internal"]
      }
    });
    const result = await new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives())
      .verifyRegistration(response, registrationExpectations());
    expect(result).toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });

  it("normalizes wrong RP ID rejection", async () => {
    const expectations = { ...registrationExpectations(), expectedRpId: "evil.example", expectedOrigin: "https://evil.example" };
    const result = await new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives())
      .verifyRegistration(registrationResponse(), expectations);
    expect(result).toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });

  it.each([
    ["crossOrigin", { crossOrigin: true }],
    ["topOrigin", { crossOrigin: false, topOrigin: "https://parent.example" }]
  ])("rejects forbidden %s before the maintained primitive", async (_label, extra) => {
    const verify = vi.fn<SimpleWebAuthnPrimitives["verifyRegistrationResponse"]>();
    const response = registrationResponse({
      response: {
        clientDataJSON: clientData("webauthn.create", CHALLENGE, ORIGIN, extra),
        attestationObject: Buffer.from([0xa0]).toString("base64url")
      }
    });
    const result = await new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({ verifyRegistrationResponse: verify }))
      .verifyRegistration(response, registrationExpectations());
    expect(result).toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects a verified credential whose COSE algorithm is outside the exact allowlist", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      decodeCredentialPublicKey: () => new Map<number, number>([[3, -8]])
    }));
    await expect(adapter.verifyRegistration(registrationResponse(), registrationExpectations()))
      .resolves.toEqual({ status: "rejected", reason: "policy_rejected" });
  });

  it("treats malformed maintained-library output as verifier unavailable", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async verifyRegistrationResponse() {
        return { verified: true };
      }
    }));
    await expect(adapter.verifyRegistration(registrationResponse(), registrationExpectations()))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
  });

  it("fails closed when the stable registration handle is no longer bound to the account", async () => {
    const repository = new TestRepository();
    repository.handle = { ...storedHandle(), accountId: "account-2" };
    const verify = vi.fn<SimpleWebAuthnPrimitives["verifyRegistrationResponse"]>();
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({ verifyRegistrationResponse: verify }));

    await expect(adapter.verifyRegistration(registrationResponse(), registrationExpectations()))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
    expect(verify).not.toHaveBeenCalled();
  });

  it("accepts a valid none-attestation fixture through the real maintained verifier", async () => {
    const result = await new SimpleWebAuthnVerifierAdapter(new TestRepository())
      .verifyRegistration(registrationResponse(), registrationExpectations());

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified fixture");
    expect(result.credential).toMatchObject({
      credentialId: CREDENTIAL_ID,
      algorithm: -7,
      signCount: 0,
      backupEligible: false,
      backupState: false,
      userPresent: true,
      userVerified: true
    });
    expect(result.credential.publicKey.byteLength).toBeGreaterThan(0);
  });

  it.each([
    ["origin", clientData("webauthn.create", CHALLENGE, "https://evil.example"), registrationExpectations(), validNoneAttestationObject()],
    ["challenge", clientData("webauthn.create", Buffer.alloc(32, 0x77).toString("base64url"), ORIGIN), registrationExpectations(), validNoneAttestationObject()],
    ["ceremony type", clientData("webauthn.get", CHALLENGE, ORIGIN), registrationExpectations(), validNoneAttestationObject()],
    [
      "RP ID hash",
      clientData("webauthn.create", CHALLENGE, "https://evil.example"),
      { ...registrationExpectations(), expectedRpId: "evil.example", expectedOrigin: "https://evil.example" },
      validNoneAttestationObject(RP_ID)
    ],
    ["COSE algorithm", clientData("webauthn.create"), registrationExpectations(), validNoneAttestationObject(RP_ID, -8)]
  ])("coarsens real maintained-verifier rejection for wrong %s", async (_label, clientDataJSON, expectations, attestationObject) => {
    const response = registrationResponse({
      response: { clientDataJSON, attestationObject, transports: ["internal"] }
    });
    await expect(new SimpleWebAuthnVerifierAdapter(new TestRepository()).verifyRegistration(response, expectations))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });

  it("uses the real maintained verifier and coarsens malformed attestation rejection", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository());
    const malformed = registrationResponse({
      response: {
        clientDataJSON: clientData("webauthn.create"),
        attestationObject: Buffer.from([0xa0]).toString("base64url")
      }
    });
    await expect(adapter.verifyRegistration(malformed, registrationExpectations()))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });
});

describe("SimpleWebAuthnVerifierAdapter authentication verification", () => {
  it("verifies a signed ES256 assertion through the real maintained library", async () => {
    const fixture = signedAuthenticationFixture(8);
    const repository = new TestRepository();
    repository.credential = storedCredential({
      publicKey: fixture.credentialPublicKey,
      signCount: 7,
      backupEligible: false,
      backupState: false
    });

    const result = await new SimpleWebAuthnVerifierAdapter(repository)
      .verifyAuthentication(fixture.response, authenticationExpectations());

    expect(result).toEqual({
      status: "verified",
      kind: "authentication",
      credential: {
        credentialRecordId: "credential-record-1",
        credentialRevision: 4,
        accountId: "account-1",
        discoveryMode: "discoverable",
        userHandleBindingVerified: true,
        previousSignCount: 7,
        newSignCount: 8,
        previousBackupEligible: false,
        backupEligible: false,
        previousBackupState: false,
        backupState: false,
        userPresent: true,
        userVerified: true
      }
    });
  });

  it.each([
    ["zero", 0],
    ["equal", 7],
    ["regressed", 6]
  ] as const)("accepts a real signed %s counter as authenticated risk telemetry", async (_label, observedCounter) => {
    const fixture = signedAuthenticationFixture(observedCounter);
    const repository = new TestRepository();
    repository.credential = storedCredential({
      publicKey: fixture.credentialPublicKey,
      signCount: 7,
      backupEligible: false,
      backupState: false
    });

    const result = await new SimpleWebAuthnVerifierAdapter(repository)
      .verifyAuthentication(fixture.response, authenticationExpectations());

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected counter anomaly to remain telemetry");
    expect(result.credential).toMatchObject({
      previousSignCount: 7,
      newSignCount: observedCounter
    });
  });

  it("globally resolves exact credential ID, binds handle/account and uses the neutral verifier counter baseline", async () => {
    const repository = new TestRepository();
    let captured: Parameters<SimpleWebAuthnPrimitives["verifyAuthenticationResponse"]>[0] | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async verifyAuthenticationResponse(options) {
        captured = options;
        return fakePrimitives().verifyAuthenticationResponse(options);
      }
    }));

    const result = await adapter.verifyAuthentication(authenticationResponse(), authenticationExpectations());

    expect(repository.credentialIdLookups).toEqual([CREDENTIAL_ID]);
    expect(captured?.credential).toEqual({
      id: CREDENTIAL_ID,
      publicKey: PUBLIC_KEY,
      counter: 0,
      transports: ["internal"]
    });
    expect(captured).toMatchObject({
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      expectedType: "webauthn.get",
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: "required" }
    });
    expect(result).toEqual({
      status: "verified",
      kind: "authentication",
      credential: {
        credentialRecordId: "credential-record-1",
        credentialRevision: 4,
        accountId: "account-1",
        discoveryMode: "discoverable",
        userHandleBindingVerified: true,
        previousSignCount: 7,
        newSignCount: 8,
        previousBackupEligible: true,
        backupEligible: true,
        previousBackupState: false,
        backupState: true,
        userPresent: true,
        userVerified: true
      }
    });
  });

  it("rejects a discoverable assertion with wrong or absent userHandle", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives());
    const wrong = authenticationResponse({
      response: {
        clientDataJSON: clientData("webauthn.get"),
        authenticatorData: Buffer.from([1]).toString("base64url"),
        signature: Buffer.from([2]).toString("base64url"),
        userHandle: Buffer.alloc(32, 0x99).toString("base64url")
      }
    });
    const absent = authenticationResponse({
      response: {
        clientDataJSON: clientData("webauthn.get"),
        authenticatorData: Buffer.from([1]).toString("base64url"),
        signature: Buffer.from([2]).toString("base64url")
      }
    });
    await expect(adapter.verifyAuthentication(wrong, authenticationExpectations()))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
    await expect(adapter.verifyAuthentication(absent, authenticationExpectations()))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
  });

  it("keeps the persisted and observed counters separate from the verifier's neutral baseline", async () => {
    const repository = new TestRepository();
    let passedCounter: number | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async verifyAuthenticationResponse(options) {
        passedCounter = options.credential.counter;
        return {
          verified: true,
          authenticationInfo: {
            credentialID: CREDENTIAL_ID,
            newCounter: 7,
            userVerified: true,
            credentialDeviceType: "multiDevice",
            credentialBackedUp: false,
            origin: ORIGIN,
            rpID: RP_ID
          }
        };
      }
    }));

    const result = await adapter.verifyAuthentication(authenticationResponse(), authenticationExpectations());
    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected authenticated counter telemetry");
    expect(result.credential).toMatchObject({ previousSignCount: 7, newSignCount: 7 });
    expect(passedCounter).toBe(0);
  });

  it("allows an authenticator's genuine unsupported 0-to-0 counter while still passing stored zero", async () => {
    const repository = new TestRepository();
    repository.credential = storedCredential({ signCount: 0 });
    let passedCounter: number | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async verifyAuthenticationResponse(options) {
        passedCounter = options.credential.counter;
        return {
          verified: true,
          authenticationInfo: {
            credentialID: CREDENTIAL_ID,
            newCounter: 0,
            userVerified: true,
            credentialDeviceType: "multiDevice",
            credentialBackedUp: false,
            origin: ORIGIN,
            rpID: RP_ID
          }
        };
      }
    }));

    const result = await adapter.verifyAuthentication(authenticationResponse(), authenticationExpectations());
    expect(result.status).toBe("verified");
    expect(passedCounter).toBe(0);
  });

  it("rejects account and credential-boundary confusion before signature verification", async () => {
    const repository = new TestRepository();
    repository.credential = storedCredential({ accountId: "account-2" });
    const verify = vi.fn<SimpleWebAuthnPrimitives["verifyAuthenticationResponse"]>();
    const result = await new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({ verifyAuthenticationResponse: verify }))
      .verifyAuthentication(authenticationResponse(), authenticationExpectations());
    expect(result).toEqual({ status: "rejected", reason: "policy_rejected" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("treats malformed authentication output as unavailable", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async verifyAuthenticationResponse() {
        return { verified: true, authenticationInfo: { newCounter: 8 } };
      }
    }));
    await expect(adapter.verifyAuthentication(authenticationResponse(), authenticationExpectations()))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
  });
});

describe("SimpleWebAuthnVerifierAdapter identifier-free discoverable login", () => {
  it("returns the account only after a real signed assertion and user-handle binding verify", async () => {
    const fixture = signedAuthenticationFixture(8);
    const repository = new TestRepository();
    repository.credential = storedCredential({
      publicKey: fixture.credentialPublicKey,
      signCount: 7,
      backupEligible: false,
      backupState: false
    });

    const result = await new SimpleWebAuthnVerifierAdapter(repository)
      .verifyDiscoverableLogin(fixture.response, discoverableLoginExpectations());

    expect(result).toEqual({
      status: "verified",
      kind: "authentication",
      purpose: "session.create",
      credentialBoundary: "discoverable_any",
      account: {
        accountId: "account-1",
        userHandleRef: "handle-ref-1",
        userHandleBindingVerified: true
      },
      credential: {
        credentialRecordId: "credential-record-1",
        credentialRevision: 4,
        algorithm: -7,
        discoveryMode: "discoverable",
        previousSignCount: 7,
        newSignCount: 8,
        previousBackupEligible: false,
        backupEligible: false,
        previousBackupState: false,
        backupState: false,
        userPresent: true,
        userVerified: true
      }
    });
  });

  it("verifies a real signed RS256 assertion for the full production algorithm allowlist", async () => {
    const fixture = signedRs256AuthenticationFixture(12);
    const repository = new TestRepository();
    repository.credential = storedCredential({
      publicKey: fixture.credentialPublicKey,
      algorithm: -257,
      signCount: 11,
      backupEligible: false,
      backupState: false
    });

    const result = await new SimpleWebAuthnVerifierAdapter(repository)
      .verifyDiscoverableLogin(fixture.response, discoverableLoginExpectations());

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified RS256 fixture");
    expect(result.credential).toMatchObject({
      algorithm: -257,
      previousSignCount: 11,
      newSignCount: 12,
      userPresent: true,
      userVerified: true
    });
    expect(result.account).toEqual({
      accountId: "account-1",
      userHandleRef: "handle-ref-1",
      userHandleBindingVerified: true
    });
  });

  it.each([
    ["zero", 0],
    ["equal", 7],
    ["regressed", 6]
  ] as const)("does not lock discoverable login on a real signed %s counter", async (_label, observedCounter) => {
    const fixture = signedAuthenticationFixture(observedCounter);
    const repository = new TestRepository();
    repository.credential = storedCredential({
      publicKey: fixture.credentialPublicKey,
      signCount: 7,
      backupEligible: false,
      backupState: false
    });

    const result = await new SimpleWebAuthnVerifierAdapter(repository)
      .verifyDiscoverableLogin(fixture.response, discoverableLoginExpectations());

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected signed counter anomaly to remain telemetry");
    expect(result.credential).toMatchObject({
      previousSignCount: 7,
      newSignCount: observedCounter
    });
  });

  it("coarsens real signed challenge, origin, type, RP, UP, UV and signature failures", async () => {
    const fixtures: Array<{
      readonly label: string;
      readonly fixture: ReturnType<typeof signedAuthenticationFixture>;
    }> = [
      { label: "challenge", fixture: signedAuthenticationFixture(8, { challenge: Buffer.alloc(32, 0x77).toString("base64url") }) },
      { label: "origin", fixture: signedAuthenticationFixture(8, { origin: "https://evil.example" }) },
      { label: "type", fixture: signedAuthenticationFixture(8, { type: "webauthn.create" }) },
      { label: "RP ID hash", fixture: signedAuthenticationFixture(8, { signedRpId: "evil.example" }) },
      { label: "UP", fixture: signedAuthenticationFixture(8, { flags: 0x04 }) },
      { label: "UV", fixture: signedAuthenticationFixture(8, { flags: 0x01 }) }
    ];
    const signedForTamper = signedAuthenticationFixture(8);
    const tamperedSignature = Buffer.from(signedForTamper.response.response.signature, "base64url");
    const signatureTail = tamperedSignature.length - 1;
    tamperedSignature[signatureTail] = (tamperedSignature[signatureTail] ?? 0) ^ 0x01;
    fixtures.push({
      label: "signature",
      fixture: {
        ...signedForTamper,
        response: authenticationResponse({
          response: {
            ...signedForTamper.response.response,
            signature: tamperedSignature.toString("base64url")
          }
        })
      }
    });

    for (const { label, fixture } of fixtures) {
      const repository = new TestRepository();
      repository.credential = storedCredential({
        publicKey: fixture.credentialPublicKey,
        signCount: 7,
        backupEligible: false,
        backupState: false
      });
      const result = await new SimpleWebAuthnVerifierAdapter(repository)
        .verifyDiscoverableLogin(fixture.response, discoverableLoginExpectations());
      expect(result, label).toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
    }
  });

  it("uses the presented credential only as an index and omits account-bound verifier inputs", async () => {
    const repository = new TestRepository();
    let captured: Parameters<SimpleWebAuthnPrimitives["verifyAuthenticationResponse"]>[0] | undefined;
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async verifyAuthenticationResponse(options) {
        captured = options;
        return fakePrimitives().verifyAuthenticationResponse(options);
      }
    }));

    const result = await adapter.verifyDiscoverableLogin(
      authenticationResponse(),
      discoverableLoginExpectations()
    );

    expect(repository.credentialIdLookups).toEqual([CREDENTIAL_ID]);
    expect(captured).toMatchObject({
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      expectedType: "webauthn.get",
      requireUserVerification: true,
      credential: {
        id: CREDENTIAL_ID,
        publicKey: PUBLIC_KEY,
        counter: 0,
        transports: ["internal"]
      }
    });
    expect(captured).not.toHaveProperty("advancedFIDOConfig");
    expect(result.status).toBe("verified");
  });

  it("collapses every credential and handle mismatch to one rejection without a handle timing oracle", async () => {
    const scenarios: Array<{
      readonly configure: (repository: TestRepository) => void;
      readonly response: ReturnType<typeof authenticationResponse>;
      readonly verifiesSignature: boolean;
    }> = [
      {
        configure: (repository) => { repository.credential = null; },
        response: authenticationResponse(),
        verifiesSignature: false
      },
      {
        configure: (repository) => {
          repository.credential = storedCredential({
            discoveryMode: "non_discoverable",
            credentialSetRef: "credential-record-1"
          });
        },
        response: authenticationResponse(),
        verifiesSignature: false
      },
      {
        configure: (repository) => { repository.handle = null; },
        response: authenticationResponse(),
        verifiesSignature: true
      },
      {
        configure: (repository) => { repository.handle = { ...storedHandle(), accountId: "account-2" }; },
        response: authenticationResponse(),
        verifiesSignature: true
      },
      {
        configure: () => undefined,
        response: authenticationResponse({
          response: {
            clientDataJSON: clientData("webauthn.get"),
            authenticatorData: Buffer.from([1]).toString("base64url"),
            signature: Buffer.from([2]).toString("base64url")
          }
        }),
        verifiesSignature: false
      },
      {
        configure: () => undefined,
        response: authenticationResponse({
          response: {
            clientDataJSON: clientData("webauthn.get"),
            authenticatorData: Buffer.from([1]).toString("base64url"),
            signature: Buffer.from([2]).toString("base64url"),
            userHandle: Buffer.alloc(32, 0x99).toString("base64url")
          }
        }),
        verifiesSignature: true
      }
    ];

    for (const scenario of scenarios) {
      const repository = new TestRepository();
      scenario.configure(repository);
      const verify = vi.fn<SimpleWebAuthnPrimitives["verifyAuthenticationResponse"]>(async (options) =>
        fakePrimitives().verifyAuthenticationResponse(options)
      );
      const result = await new SimpleWebAuthnVerifierAdapter(
        repository,
        fakePrimitives({ verifyAuthenticationResponse: verify })
      ).verifyDiscoverableLogin(scenario.response, discoverableLoginExpectations());
      expect(result).toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
      expect(Object.keys(result)).toEqual(["status", "reason"]);
      expect(JSON.stringify(result)).not.toMatch(/account-1|handle-ref-1|credential-record-1/);
      expect(verify).toHaveBeenCalledTimes(scenario.verifiesSignature ? 1 : 0);
    }
  });

  it("accepts genuine zero counters but still rejects UV and backup-policy failures generically", async () => {
    const repository = new TestRepository();
    repository.credential = storedCredential({ signCount: 0 });
    const outputs = [
      {
        verified: true,
        authenticationInfo: {
          credentialID: CREDENTIAL_ID,
          newCounter: 0,
          userVerified: false,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: false,
          origin: ORIGIN,
          rpID: RP_ID
        }
      },
      {
        verified: true,
        authenticationInfo: {
          credentialID: CREDENTIAL_ID,
          newCounter: 0,
          userVerified: true,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
          origin: ORIGIN,
          rpID: RP_ID
        }
      }
    ];
    for (const output of outputs) {
      const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
        async verifyAuthenticationResponse() { return output; }
      }));
      await expect(adapter.verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations()))
        .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
    }

    const zeroResult = await new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives({
      async verifyAuthenticationResponse() {
        return {
          verified: true,
          authenticationInfo: {
            credentialID: CREDENTIAL_ID,
            newCounter: 0,
            userVerified: true,
            credentialDeviceType: "multiDevice",
            credentialBackedUp: false,
            origin: ORIGIN,
            rpID: RP_ID
          }
        };
      }
    })).verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations());
    expect(zeroResult.status).toBe("verified");
  });

  it("turns malformed maintained output into an opaque unavailable error", async () => {
    const canary = "discoverable-output-CANARY";
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async verifyAuthenticationResponse() {
        return { verified: true, authenticationInfo: { credentialID: canary } };
      }
    }));

    const thrown = await adapter.verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations())
      .then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(PasskeyVerifierUnavailableError);
    expect(String(thrown)).toBe("PasskeyVerifierUnavailableError: passkey verifier unavailable");
    expect(String(thrown)).not.toContain(canary);
  });

  it("never reads the stored handle when the maintained signature check rejects", async () => {
    const fixture = signedAuthenticationFixture(8);
    const signature = Buffer.from(fixture.response.response.signature, "base64url");
    const tail = signature.length - 1;
    signature[tail] = (signature[tail] ?? 0) ^ 0x01;
    const repository = new TestRepository();
    repository.credential = storedCredential({
      publicKey: fixture.credentialPublicKey,
      signCount: 7,
      backupEligible: false,
      backupState: false
    });
    const handleLookup = vi.spyOn(repository, "findPasskeyUserHandleByRef");
    const response = authenticationResponse({
      response: { ...fixture.response.response, signature: signature.toString("base64url") }
    });

    await expect(new SimpleWebAuthnVerifierAdapter(repository)
      .verifyDiscoverableLogin(response, discoverableLoginExpectations()))
      .resolves.toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
    expect(handleLookup).not.toHaveBeenCalled();
  });

  it("contains proxy and getter canaries from every trusted adapter output boundary", async () => {
    const cases: Array<() => Promise<unknown>> = [];

    {
      const repository = new TestRepository();
      repository.credential = new Proxy({} as StoredPasskeyCredential, {
        getPrototypeOf() { throw new Error("credential-proxy-CANARY"); }
      });
      const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives());
      cases.push(() => adapter.verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations()));
    }
    {
      const repository = new TestRepository();
      repository.handle = new Proxy({} as StoredPasskeyUserHandle, {
        ownKeys() { throw new Error("handle-proxy-CANARY"); }
      });
      const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives());
      cases.push(() => adapter.verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations()));
    }
    {
      const output = new Proxy({}, {
        getPrototypeOf() { throw new Error("verifier-proxy-CANARY"); }
      });
      const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
        async verifyAuthenticationResponse() { return output; }
      }));
      cases.push(() => adapter.verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations()));
    }
    {
      const decoded = new Proxy({}, {
        getPrototypeOf() { throw new Error("cose-proxy-CANARY"); }
      });
      const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
        decodeCredentialPublicKey() { return decoded; }
      }));
      cases.push(() => adapter.verifyDiscoverableLogin(authenticationResponse(), discoverableLoginExpectations()));
    }

    for (const run of cases) {
      const thrown = await run().then(() => null, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(PasskeyVerifierUnavailableError);
      expect(String(thrown)).toBe("PasskeyVerifierUnavailableError: passkey verifier unavailable");
      expect(String(thrown)).not.toContain("CANARY");
    }
  });

  it("rejects runtime purpose confusion across all three verifier ports", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives());
    const registration = {
      ...registrationExpectations(),
      purpose: { type: "session.create", targetDigest: "c".repeat(64) }
    } as unknown as RegistrationVerificationExpectations;
    const stepUp = {
      ...authenticationExpectations(),
      purpose: { type: "session.create", targetDigest: "c".repeat(64) }
    } as unknown as AuthenticationVerificationExpectations;
    const login = {
      ...discoverableLoginExpectations(),
      purpose: { type: "session.step_up", targetDigest: "b".repeat(64) }
    } as unknown as DiscoverableLoginVerificationExpectations;

    await expect(adapter.verifyRegistration(registrationResponse(), registration))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
    await expect(adapter.verifyAuthentication(authenticationResponse(), stepUp))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
    await expect(adapter.verifyDiscoverableLogin(authenticationResponse(), login))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
  });

  it("rejects ignored account hints and every other extra root key on the anonymous port", async () => {
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives());
    const options = {
      expectedChallenge: CHALLENGE,
      expectedRpId: RP_ID,
      timeoutMs: 300_000,
      credentialBoundary: { mode: "discoverable_any", credentialSetRef: null },
      expectedAccountId: "account-1"
    } as unknown as Parameters<SimpleWebAuthnVerifierAdapter["createDiscoverableLoginOptions"]>[0];
    const expectations = {
      ...discoverableLoginExpectations(),
      expectedAccountId: "account-1"
    } as unknown as DiscoverableLoginVerificationExpectations;

    await expect(adapter.createDiscoverableLoginOptions(options))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
    await expect(adapter.verifyDiscoverableLogin(authenticationResponse(), expectations))
      .rejects.toBeInstanceOf(PasskeyVerifierUnavailableError);
  });
});

describe("secret and error boundary", () => {
  it("does not log or return a canary from maintained-library rejection", async () => {
    const canary = "challenge-secret-CANARY-never-expose";
    const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined)
    );
    const adapter = new SimpleWebAuthnVerifierAdapter(new TestRepository(), fakePrimitives({
      async verifyRegistrationResponse() {
        throw new Error(canary);
      }
    }));

    const result = await adapter.verifyRegistration(registrationResponse(), registrationExpectations());

    expect(result).toEqual({ status: "rejected", reason: "invalid_webauthn_response" });
    expect(JSON.stringify(result)).not.toContain(canary);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("replaces repository causes with an opaque unavailable error", async () => {
    const canary = "encrypted-handle-CANARY-never-expose";
    const repository = new TestRepository();
    repository.findPasskeyCredentialById = async () => {
      throw new Error(canary);
    };
    const adapter = new SimpleWebAuthnVerifierAdapter(repository, fakePrimitives());

    const thrown = await adapter.verifyAuthentication(authenticationResponse(), authenticationExpectations())
      .then(() => null, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(PasskeyVerifierUnavailableError);
    expect(String(thrown)).toBe("PasskeyVerifierUnavailableError: passkey verifier unavailable");
    expect(String(thrown)).not.toContain(canary);
  });
});
