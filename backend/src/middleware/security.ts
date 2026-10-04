import { FastifyReply, FastifyRequest } from "fastify";
import { isProduction } from "../config/env.js";

/**
 * OWASP-oriented response hardening.
 *
 * Applied on every request. `request.id` is set by the request-context hook and
 * is echoed back so a user-reported failure can be traced to a server log line.
 */
export async function securityHeadersHook(request: FastifyRequest, reply: FastifyReply) {
  reply.header("X-Request-Id", request.id);

  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-DNS-Prefetch-Control", "off");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Resource-Policy", "same-site");
  reply.header("X-Permitted-Cross-Domain-Policies", "none");
  reply.removeHeader("X-Powered-By");

  reply.header(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );

  // The API only ever returns JSON and evidence images; it never executes
  // first-party script, so a strict policy costs nothing.
  reply.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
    ].join("; "),
  );

  // No caching of authenticated API payloads in shared caches.
  if (!reply.hasHeader("Cache-Control")) {
    reply.header("Cache-Control", "no-store");
  }

  if (isProduction) {
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
}
