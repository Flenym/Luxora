import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "../domain/store.js";
import { unauthenticated } from "../errors.js";
import { TokenSecurity } from "../security.js";

export function createAuthGuard(security: TokenSecurity, store: Store) {
  return async function authGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ") || header.length <= 7) {
      throw unauthenticated();
    }
    const principal = await security.verifyAccessToken(header.slice(7));
    if (!store.isSessionActive(principal.sessionId, principal.userId, new Date().toISOString())) {
      throw unauthenticated("Session is no longer active");
    }
    request.auth = principal;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    auth: import("../domain/types.js").AuthenticatedPrincipal;
  }
}
