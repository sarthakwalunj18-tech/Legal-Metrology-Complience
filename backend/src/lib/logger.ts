import { env, isProduction } from "../config/env.js";

/** Keys whose values must never appear in logs, no matter the nesting depth. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "gemini_api_key",
  "geminiapikey",
  "supabase_service_role_key",
  "supabase_service_role",
  "service_role_key",
  "secret",
  "media_signing_secret",
  "signature",
  "x-api-key",
]);

const MAX_DEPTH = 4;

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Defensive: scrub anything that looks like a bearer token or long key.
    if (/^eyJ[A-Za-z0-9_-]{20,}\./.test(value)) return "[redacted-jwt]";
    if (value.length > 512) return `${value.slice(0, 512)}…[truncated]`;
    return value;
  }
  return value;
}

export function redact(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return "[depth-limit]";

  if (Array.isArray(input)) return input.slice(0, 50).map((item) => redact(item, depth + 1));

  if (input instanceof Error) {
    return {
      name: input.name,
      message: isProduction ? "[error message redacted]" : input.message,
    };
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = redactValue(key, redact(value, depth + 1));
    }
    return out;
  }

  return input;
}

export type LogFields = Record<string, unknown>;

/**
 * Single structured log sink.
 *
 * In production this emits newline-delimited JSON so it can be shipped by any
 * agent; in development it stays human readable but still carries the same fields.
 */
class Logger {
  private readonly pretty = !isProduction && env.LOG_LEVEL !== "silent";
  private readonly level: string;

  constructor() {
    const order = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
    this.level = order.indexOf(env.LOG_LEVEL ?? "info") >= 0 ? (env.LOG_LEVEL as string) : "info";
  }

  private enabled(level: string): boolean {
    const order = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
    if (this.level === "silent") return false;
    return order.indexOf(level) <= order.indexOf(this.level);
  }

  private emit(level: string, message: string, fields?: LogFields): void {
    if (!this.enabled(level)) return;

    const safeFields = fields ? (redact(fields) as LogFields) : undefined;
    const stream = level === "error" || level === "fatal" ? console.error : level === "warn" ? console.warn : console.log;

    if (this.pretty) {
      if (safeFields && Object.keys(safeFields).length > 0) {
        stream(`[${level.toUpperCase()}] ${message}`, safeFields);
      } else {
        stream(`[${level.toUpperCase()}] ${message}`);
      }
      return;
    }

    stream(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        service: "legal-metrology-api",
        message,
        ...(safeFields ?? {}),
      }),
    );
  }

  debug(message: string, fields?: LogFields) {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: LogFields) {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields) {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields) {
    this.emit("error", message, fields);
  }
}

export const logger = new Logger();

/** Wraps an async route body so rejections reach the Fastify error handler. */
export async function withErrorBoundary<T>(
  operation: string,
  fields: LogFields,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    logger.debug(`${operation} completed`, { ...fields, durationMs: Date.now() - startedAt, status: "ok" });
    return result;
  } catch (error) {
    logger.error(`${operation} failed`, {
      ...fields,
      durationMs: Date.now() - startedAt,
      status: "error",
      error,
    });
    throw error;
  }
}
