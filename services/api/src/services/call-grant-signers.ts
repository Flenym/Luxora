import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
import type {
  LiveKitJoinTokenDescriptor,
  SfuTokenSigner,
  TurnCredentialSigner
} from "@luxora/call-control";

/**
 * LiveKit join-token signer (CALLS_PLATFORM §6). Issues a compact HS256 JWT
 * with the exact least-privilege video grant from the descriptor: room join
 * only, no create/list/admin/record/ingress, subscribe-only plus the
 * authorized publish sources. The API secret never leaves this module.
 */
export function createSfuSigner(apiKey: string, apiSecret: string): SfuTokenSigner {
  const key = new TextEncoder().encode(apiSecret);
  return {
    async signJoinToken(descriptor: LiveKitJoinTokenDescriptor): Promise<string> {
      const issuedAtSeconds = Math.floor(descriptor.issuedAtMs / 1_000);
      return new SignJWT({
        metadata: descriptor.participantMetadata,
        video: {
          roomJoin: descriptor.videoGrant.roomJoin,
          room: descriptor.videoGrant.room,
          canPublish: descriptor.videoGrant.canPublish,
          ...(descriptor.videoGrant.canPublishSources === undefined
            ? {}
            : { canPublishSources: [...descriptor.videoGrant.canPublishSources] }),
          canSubscribe: descriptor.videoGrant.canSubscribe,
          roomCreate: descriptor.videoGrant.roomCreate,
          roomList: descriptor.videoGrant.roomList,
          roomAdmin: descriptor.videoGrant.roomAdmin,
          roomRecord: descriptor.videoGrant.roomRecord,
          ingressAdmin: descriptor.videoGrant.ingressAdmin,
          canPublishData: descriptor.videoGrant.canPublishData,
          canUpdateOwnMetadata: descriptor.videoGrant.canUpdateOwnMetadata
        }
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(apiKey)
        .setSubject(descriptor.participantIdentity)
        .setJti(descriptor.tokenId)
        .setIssuedAt(issuedAtSeconds)
        .setNotBefore(issuedAtSeconds)
        .setExpirationTime(issuedAtSeconds + descriptor.ttlSeconds)
        .sign(key);
    }
  };
}

/**
 * coturn REST credential signer. Returns base64(HMAC-SHA1(shared secret,
 * username)); the shared secret never leaves this module.
 */
export function createTurnSigner(sharedSecret: string): TurnCredentialSigner {
  return {
    async signUsername(username: string): Promise<string> {
      return createHmac("sha1", sharedSecret).update(username, "utf8").digest("base64");
    }
  };
}
