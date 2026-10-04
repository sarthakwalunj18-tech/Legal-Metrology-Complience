import { randomUUID } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { logger } from "../lib/logger.js";

/**
 * Correlation id for every inbound request.
 *
 * Honours an upstream `X-Request-Id` so a trace survives the Next.js BFF hop,
 * otherwise mints one. Never derived from user input in an unsafe way.
 *
 * Declared `async` on purpose: a synchronous 2-argument `onRequest` hook never
 * settles under fastify@5.12, so every onRequest hook in this codebase must be
 * a promise-returning function.
 */
export async function requestContextHook(request: FastifyRequest, reply: FastifyReply) {
  const inbound = request.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const sanitized =
    typeof candidate === "string" && /^[A-Za-z0-9._-]{6,64}$/.test(candidate) ? candidate : `req_${randomUUID()}`;

  request.id = sanitized;
  reply.header("X-Request-Id", sanitized);
}

/**
 * Structured access log emitted once per completed request.
 * Records: requestId, userId, role, route, method, status, duration.
 */
export function accessLogHook(request: FastifyRequest, reply: FastifyReply): void {
  const fields = {
    requestId: request.id,
    method: request.method,
    route: request.routeOptions?.url ?? request.url,
    status: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime * 100) / 100,
    userId: request.user?.id,
    userRole: request.user?.role,
    ip: request.ip,
  };

  if (reply.statusCode >= 500) logger.error("request", fields);
  else if (reply.statusCode >= 400) logger.warn("request", fields);
  else logger.debug("request", fields);
}
