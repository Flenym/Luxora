# Passkey verifier adapter audit — Beta-0.1

Owner: Flenym  
Review date: 2026-08-04  
Scope: `services/api/src/passkeys/simplewebauthn-adapter.ts`, its contract tests, and exact package metadata

## Decision

Luxora delegates WebAuthn parsing, attestation/assertion verification, signature verification, RP ID hashing, challenge/origin/type verification and UP/UV evaluation to the maintained `@simplewebauthn/server` package. Beta-0.1 pins version `13.3.2` exactly. Its published package declares Node `>=20.0.0`; Luxora runs Node `>=22.0.0`.

The adapter is fail-closed around the maintained library. Expected hostile-input or library verification failures become only:

```json
{"status":"rejected","reason":"invalid_webauthn_response"}
```

Policy violations become the equally coarse `policy_rejected`. Malformed library outputs, repository corruption/failure, invalid trusted expectations and option-generator defects throw only `PasskeyVerifierUnavailableError: passkey verifier unavailable`. Causes are neither attached nor logged.

## Upstream evidence

- Official server documentation: <https://simplewebauthn.dev/docs/packages/server>
- Exact published package: <https://www.npmjs.com/package/@simplewebauthn/server/v/13.3.2>
- Registration verification source at reviewed git commit `803d1da15bb6868fcaf557fcdcd24b73cb82bcd9`: <https://github.com/MasterKale/SimpleWebAuthn/blob/803d1da15bb6868fcaf557fcdcd24b73cb82bcd9/packages/server/src/registration/verifyRegistrationResponse.ts>
- Authentication verification source at the same commit: <https://github.com/MasterKale/SimpleWebAuthn/blob/803d1da15bb6868fcaf557fcdcd24b73cb82bcd9/packages/server/src/authentication/verifyAuthenticationResponse.ts>
- Registration option generation source: <https://github.com/MasterKale/SimpleWebAuthn/blob/803d1da15bb6868fcaf557fcdcd24b73cb82bcd9/packages/server/src/registration/generateRegistrationOptions.ts>
- Authentication option generation source: <https://github.com/MasterKale/SimpleWebAuthn/blob/803d1da15bb6868fcaf557fcdcd24b73cb82bcd9/packages/server/src/authentication/generateAuthenticationOptions.ts>

Registry verification on 2026-08-04 found package version `13.3.2`, MIT license, Node engine `>=20.0.0`, publish date 2026-06-24, tarball SHA-512 integrity `sha512-KEDhfcGP1PAKRVSDjA3npTQFqS2b/srm+ipoNBNHdkzrHAlaRQUTE+a5f4ywsx6thxAw1NU2rYcLEY1949RGbQ==`, and git head `803d1da15bb6868fcaf557fcdcd24b73cb82bcd9`. The exact version and integrity are retained in `services/api/package-lock.json`.

## Security boundary

The service/HTTP boundary, not the client, computes the exact raw response byte length and response digest before passing the parsed credential into the passkey domain. The existing verifier interface supplies the server-computed byte length to this adapter; the digest remains in `VerifyCeremonyCommand` for idempotency and is intentionally not added to the verifier interface.

The adapter then applies this sequence:

1. Validate trusted ceremony expectations and the server-computed byte-length bound.
2. Strictly parse the JSON credential, require canonical base64url fields and exact `id === rawId`, and reject cross-origin client data (`crossOrigin: true`) or any `topOrigin` before library verification. Missing or explicit `crossOrigin: false` are the only accepted forms.
3. Pass exact challenge, one exact origin, one exact RP ID, expected ceremony type, UP/UV requirements and the exact `[-7, -257]` allowlist to the maintained library.
4. Strictly validate the library's output shape and post-bind returned credential ID, RP ID and origin.
5. Decode the verified COSE key with the maintained library helper and accept only ES256 (`-7`) or RS256 (`-257`) from the ceremony allowlist.

Registration options use the stable 32-byte opaque user handle obtained through a narrow repository/cipher mapper. It must be encrypted at rest; plaintext exists only at the adapter call boundary and is copied defensively. Verification re-resolves the handle reference and account binding before accepting a credential. Options require resident keys, `requireResidentKey`, UV, `attestation: none`, exact RP configuration and the two allowed algorithms. Existing account credentials are included in `excludeCredentials`; generation fails closed above the platform maximum of 20 credentials.

Authentication first performs a global exact lookup by canonical credential ID. It then binds the row to the expected account, discovery boundary, stable user-handle record, stored COSE algorithm and immutable backup eligibility. Discoverable assertions must include the exact user handle. Non-discoverable assertions may omit it because the server supplied an exact credential allow-list; if present, it must match. Comparison uses constant-time byte equality.

The real stored signature counter is always passed to `verifyAuthenticationResponse`. A stored positive counter must strictly advance. Authenticators that genuinely do not support counters may remain `0 -> 0`; the adapter never substitutes zero to suppress maintained-library replay checks. The successful result contains both previous and new counters plus the exact credential revision. The Store/service transaction must compare-and-swap that revision and counter while consuming the ceremony; verifier success alone must never update or authenticate anything.

## Required integration invariants

- The repository mapper must expose only exact lookups, decrypt user handles only for the adapter, return fresh `Uint8Array` values, and never log lookup arguments, values, misses or causes.
- Registration names (`rpName`, `userName`, `userDisplayName`) must come from authenticated server records/configuration, never from the WebAuthn response. The opaque user-handle bytes remain distinct from display identity.
- `credentialSetRef` is `null` for discoverable Beta-0.1 credentials. For the currently supported non-discoverable form it is an opaque secure credential-record reference, resolved by exact record ID.
- Credential creation and authentication options must be stored/bound to the same one-time ceremony challenge that verification resolves.
- The service must perform credential persistence, backup-state update, counter update and ceremony consumption in one revision-checked transaction. A CAS conflict is an authentication failure/retry, never a reason to accept a stale verification.
- The API multi-stage container build copies and builds `packages/passkey-domain` before API `npm ci`, then carries only its package metadata, production dependency directory and compiled `dist` into the non-root runtime image. The root BuildKit context allowlist includes only this package's lockfile, build config and source.

## Adversarial coverage

The adapter contract suite covers:

- exact registration and authentication option policy, stable handle use and `excludeCredentials`;
- discoverable and non-discoverable option boundaries;
- wrong origin, RP ID, challenge and ceremony type;
- forbidden `crossOrigin` and `topOrigin`;
- wrong or absent discoverable `userHandle`, account/boundary confusion and exact global credential lookup;
- COSE algorithm rejection, credential/public-key/transports and BE/BS mapping;
- positive non-advancing counters, genuine `0 -> 0`, and proof that the actual stored counter enters the maintained library;
- malformed generator/verifier outputs and repository defects;
- library/repository secret canaries with assertions that no canary enters results, error messages or console calls;
- real `@simplewebauthn/server` none-attestation success, wrong origin/challenge/type/RP hash/algorithm rejections, signed ES256 assertion success and non-advancing-counter rejection, proving both production cryptographic paths and the coarse rejection boundary.

## Verification record

Run from `services/api` under Node 22:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm pack --dry-run
```

The final command results and exact test counts are reported in the implementation handoff so they cannot become stale in this audit document as parallel server work adds suites.
