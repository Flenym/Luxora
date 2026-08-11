import type { ApiErrorCode } from "@luxora/protocol";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, "BAD_REQUEST", message, details);
export const unauthenticated = (message = "Authentication required", details?: Record<string, unknown>) =>
  new AppError(401, "UNAUTHENTICATED", message, details);
export const forbidden = (
  message = "You do not have permission to perform this action",
  details?: Record<string, unknown>
) => new AppError(403, "FORBIDDEN", message, details);
export const notFound = (message = "Resource not found", details?: Record<string, unknown>) =>
  new AppError(404, "NOT_FOUND", message, details);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(409, "CONFLICT", message, details);
export const rateLimited = (
  message = "Too many requests",
  details?: Record<string, unknown>
) => new AppError(429, "RATE_LIMITED", message, details);
export const serviceUnavailable = (message: string) => new AppError(503, "SERVICE_UNAVAILABLE", message);
