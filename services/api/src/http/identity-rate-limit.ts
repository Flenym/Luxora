import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { rateLimited } from "../errors.js";

interface AuthenticatedLimitPolicy {
  accountMax: number;
  deviceSessionMax: number;
  timeWindow: string;
}

export interface IdentityRateLimitGuards {
  discovery: preHandlerAsyncHookHandler;
  requestCreate: preHandlerAsyncHookHandler;
  relationshipMutation: preHandlerAsyncHookHandler;
  safetyReport: preHandlerAsyncHookHandler;
}

function createAuthenticatedGuard(
  app: FastifyInstance,
  policy: AuthenticatedLimitPolicy
): preHandlerAsyncHookHandler {
  // These bounded local stores supplement the network/IP limiter. The account
  // key aggregates all current device sessions while the session key keeps one
  // noisy device from consuming the whole account allowance. Access-token IDs
  // are deliberately not keys because refresh must not reset the bucket.
  const accountLimit = app.createRateLimit({
    max: policy.accountMax,
    timeWindow: policy.timeWindow,
    keyGenerator: (request) => `account:${request.auth.userId}`
  });
  const deviceSessionLimit = app.createRateLimit({
    max: policy.deviceSessionMax,
    timeWindow: policy.timeWindow,
    keyGenerator: (request) => `device-session:${request.auth.sessionId}`
  });

  return async function authenticatedRateLimit(request: FastifyRequest): Promise<void> {
    const deviceSession = await deviceSessionLimit(request);
    if (!deviceSession.isAllowed && deviceSession.isExceeded) throw rateLimited();
    const account = await accountLimit(request);
    if (!account.isAllowed && account.isExceeded) throw rateLimited();
  };
}

export function createIdentityRateLimitGuards(app: FastifyInstance): IdentityRateLimitGuards {
  return {
    discovery: createAuthenticatedGuard(app, {
      accountMax: 30,
      deviceSessionMax: 20,
      timeWindow: "1 minute"
    }),
    requestCreate: createAuthenticatedGuard(app, {
      accountMax: 10,
      deviceSessionMax: 8,
      timeWindow: "1 minute"
    }),
    relationshipMutation: createAuthenticatedGuard(app, {
      accountMax: 30,
      deviceSessionMax: 20,
      timeWindow: "1 minute"
    }),
    safetyReport: createAuthenticatedGuard(app, {
      accountMax: 10,
      deviceSessionMax: 8,
      timeWindow: "1 hour"
    })
  };
}
