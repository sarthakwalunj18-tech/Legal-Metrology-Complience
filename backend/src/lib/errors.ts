import { isProduction } from "../config/env.js";

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "INVALID_TOKEN"
  | "FORBIDDEN"
  | "INSUFFICIENT_PERMISSIONS"
  | "RESOURCE_FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export interface SerializedError {
  code: ErrorCode;
  message: string;
  statusCode: number;
  requestId?: string;
  details?: unknown;
}

/**
 * Base class for every error that is safe to describe to a client.
 * Anything thrown that is *not* an AppError is treated as an unexpected fault
 * and reported as a generic 500 so internals never leak.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? true;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(requestId?: string): SerializedError {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(requestId ? { requestId } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = "The request payload failed validation.", details?: unknown) {
    super(400, "VALIDATION_ERROR", message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication is required to access this resource.", code: ErrorCode = "UNAUTHENTICATED") {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.", code: ErrorCode = "FORBIDDEN") {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    super(404, "NOT_FOUND", identifier ? `${resource} '${identifier}' was not found.` : `${resource} was not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, { details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, "PAYLOAD_TOO_LARGE", message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message: string) {
    super(415, "UNSUPPORTED_MEDIA_TYPE", message);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(429, "RATE_LIMIT_EXCEEDED", message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TimeoutError extends AppError {
  constructor(message = "The operation exceeded the allowed time budget.") {
    super(504, "TIMEOUT", message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "The service is temporarily unable to handle this request.") {
    super(503, "SERVICE_UNAVAILABLE", message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Normalises any thrown value into a client-safe payload.
 *
 * Fastify/Node errors are mapped deliberately so that connection aborts, timeouts
 * and oversized payloads surface the right status without exposing stack traces.
 */
export function serializeError(error: unknown, requestId?: string): SerializedError {
  if (isAppError(error)) {
    return error.toJSON(requestId);
  }

  const candidate = error as
    | { statusCode?: number; code?: string; message?: string }
    | null
    | undefined;

  const statusCode = typeof candidate?.statusCode === "number" ? candidate.statusCode : 500;

  if (statusCode === 413) {
    return {
      code: "PAYLOAD_TOO_LARGE",
      message: "The uploaded payload exceeds the configured size limit.",
      statusCode,
      ...(requestId ? { requestId } : {}),
    };
  }

  if (candidate?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return {
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "The supplied Content-Type is not supported by this endpoint.",
      statusCode: 415,
      ...(requestId ? { requestId } : {}),
    };
  }

  if (candidate?.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || candidate?.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
    return {
      code: "BAD_REQUEST",
      message: "The request body is missing or is not valid JSON.",
      statusCode: 400,
      ...(requestId ? { requestId } : {}),
    };
  }

  if (candidate?.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return {
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body exceeds the configured size limit.",
      statusCode: 413,
      ...(requestId ? { requestId } : {}),
    };
  }

  // Anything we do not explicitly recognise is an internal fault. The real
  // message is only ever written to the server log.
  return {
    code: "INTERNAL_ERROR",
    message: isProduction
      ? "An unexpected error occurred while processing your request."
      : candidate?.message || "An unexpected error occurred while processing your request.",
    statusCode: 500,
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * Small helper for the many endpoints that still use Fastify's `reply.send`.
 * Keeps every success response on the same `{ success, data }` envelope.
 */
export function sendData<T>(payload: T) {
  return { success: true as const, data: payload };
}

export function sendError(error: SerializedError) {
  return { success: false as const, error };
}
