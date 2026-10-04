import { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  /** Bucket name, so distinct limiters never share counters. */
  name: string;
}

interface Bucket {
  count: number;
  resetTime: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window in-memory rate limiter.
 *
 * Buckets are keyed by authenticated user id when available and by client IP
 * otherwise, so one noisy inspector cannot exhaust the budget of another and an
 * unauthenticated attacker cannot trivially rotate identities.
 */
class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimitConfig) {}

  /** Drops expired buckets so the map cannot grow without bound. */
  sweep(now: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetTime) this.buckets.delete(key);
    }
  }

  private clientKey(request: FastifyRequest): string {
    const userId = request.user?.id;
    if (userId) return `u:${userId}`;
    return `ip:${request.ip ?? request.socket.remoteAddress ?? "unknown"}`;
  }

  check(request: FastifyRequest): RateLimitResult {
    const route = request.routeOptions?.url ?? new URL(request.url, "http://localhost").pathname;
    const key = `${this.config.name}|${this.clientKey(request)}|${route}`;

    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetTime) {
      bucket = { count: 1, resetTime: now + this.config.windowMs };
      this.buckets.set(key, bucket);
    } else {
      bucket.count += 1;
    }

    const allowed = bucket.count <= this.config.maxRequests;
    const remaining = Math.max(0, this.config.maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetTime - now) / 1000));

    if (!allowed) {
      logger.warn("Rate limit exceeded", {
        requestId: request.id,
        limiter: this.config.name,
        route,
        client: this.clientKey(request),
      });
    }

    return { allowed, remaining, retryAfterSeconds };
  }

  applyHeaders(reply: FastifyReply, result: RateLimitResult): void {
    reply.header("X-RateLimit-Limit", this.config.maxRequests);
    reply.header("X-RateLimit-Remaining", result.remaining);
    reply.header("X-RateLimit-Window", Math.round(this.config.windowMs / 1000));
    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfterSeconds);
    }
  }
}

const registry = new Map<string, RateLimiter>();

function createRateLimiter(config: RateLimitConfig): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const limiter = new RateLimiter(config);
  registry.set(config.name, limiter);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = limiter.check(request);
    limiter.applyHeaders(reply, result);

    if (!result.allowed) {
      reply.status(429);
      return reply.send({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${result.retryAfterSeconds} second(s).`,
          statusCode: 429,
          requestId: request.id,
          retryAfter: result.retryAfterSeconds,
        },
      });
    }
  };
}

/** General purpose budget for ordinary reads/writes. */
export const standardRateLimit = createRateLimiter({
  name: "standard",
  maxRequests: env.RATE_LIMIT_STANDARD,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
});

/** Tight budget for expensive AI work: upload, OCR, extraction, RAG, analysis. */
export const expensiveAiRateLimit = createRateLimiter({
  name: "ai",
  maxRequests: env.RATE_LIMIT_AI,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
});

/** Very tight budget for authentication endpoints (brute-force resistance). */
export const authRateLimit = createRateLimiter({
  name: "auth",
  maxRequests: env.RATE_LIMIT_AUTH,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
});

const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const limiter of registry.values()) limiter.sweep(now);
}, Math.min(env.RATE_LIMIT_WINDOW_MS, 30_000));

// Never keep the process alive purely for bucket cleanup.
sweepInterval.unref?.();
