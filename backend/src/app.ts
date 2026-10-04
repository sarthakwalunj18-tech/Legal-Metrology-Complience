import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { corsOrigins, env, publicApiUrl } from "./config/env.js";
import multipart from "@fastify/multipart";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { scanRoutes } from "./routes/scans.js";
import { inspectionRoutes } from "./routes/inspections.js";
import { ruleRoutes } from "./routes/rules.js";
import { ragRoutes } from "./routes/rag.js";
import { violationRoutes } from "./routes/violations.js";
import { reviewRoutes } from "./routes/reviews.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { userRoutes } from "./routes/users.js";
import { searchRoutes } from "./routes/search.js";
import { mediaRoutes } from "./routes/media.js";
import { securityHeadersHook } from "./middleware/security.js";
import { accessLogHook, requestContextHook } from "./middleware/request-context.js";
import { NotFoundError, serializeError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Structured logging is handled by `lib/logger.ts`; Fastify's own request
    // logging would duplicate every line.
    logger: false,
    // Never trust proxy headers unless explicitly configured.
    trustProxy: false,
    bodyLimit: env.BODY_LIMIT_BYTES,
    requestIdHeader: false,
  });

  // Correlation id first so every later hook/log line can reference it.
  app.addHook("onRequest", requestContextHook);
  app.addHook("onRequest", securityHeadersHook);
  app.addHook("onResponse", accessLogHook);

  // Security & Utilities
  app.register(sensible);
  app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin/server-to-server calls arrive without an Origin header.
      if (!origin) return callback(null, true);
      callback(null, corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"],
    maxAge: 600,
  });

  // Multipart file upload support
  app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_BYTES,
      files: env.UPLOAD_MAX_FILES,
      fields: 40,
    },
  });

  // Single global error handler: internal details stay in the log.
  app.setErrorHandler((error: unknown, request, reply) => {
    const serialized = serializeError(error, request.id);

    if (serialized.statusCode >= 500) {
      logger.error("Unhandled request failure", {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        userId: request.user?.id,
        error,
      });
    } else {
      logger.warn("Request rejected", {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        userId: request.user?.id,
        code: serialized.code,
        statusCode: serialized.statusCode,
      });
    }

    return reply.status(serialized.statusCode).send({ success: false, error: serialized });
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError(`Route ${request.method} ${request.url}`);
    return reply.status(404).send({ success: false, error: error.toJSON(request.id) });
  });

  // Root & Routes
  app.register(healthRoutes, { prefix: "/api" });
  app.register(authRoutes, { prefix: "/api" });
  app.register(scanRoutes, { prefix: "/api" });
  app.register(inspectionRoutes, { prefix: "/api" });
  app.register(ruleRoutes, { prefix: "/api" });
  app.register(ragRoutes, { prefix: "/api" });
  app.register(violationRoutes, { prefix: "/api" });
  app.register(reviewRoutes, { prefix: "/api" });
  app.register(analyticsRoutes, { prefix: "/api" });
  app.register(userRoutes, { prefix: "/api" });
  app.register(searchRoutes, { prefix: "/api" });
  app.register(mediaRoutes, { prefix: "/api" });

  app.get("/", async () => {
    return {
      name: "AI Legal Metrology Compliance API",
      status: "running",
      documentation: "/api/health",
      version: "1.0.0",
      publicApiUrl,
    };
  });

  return app;
}
